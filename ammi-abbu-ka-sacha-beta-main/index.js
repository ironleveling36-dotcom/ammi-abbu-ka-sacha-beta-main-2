import './network-shield.js';
import { createIpv4TelegramAgent, installBulletproofTelegramTransport } from './network-shield.js';
import { installBossMirror } from './boss-mirror.js';
import {
  REQUIRED_CHANNEL,
  formatChannelJoinCard,
  checkUserChannelMembership,
  clearChannelMemberCache,
  isTestRunner,
  getChannelGateState,
  setChannelGate
} from './channel-gate.js';
import http from 'http';
import net from 'node:net';
import crypto from 'node:crypto';
import { Telegraf, Markup } from 'telegraf';
import { handleSwiggyProHttp } from './swiggy-pro-api.js';
import { getProVaultSource } from './swiggy-pro-store.js';
import { readSwiggyPlacement } from './swiggy-placement-journal.js';
import { logThrottled, startMemoryGuard, perfSnapshot } from './perf-guard.js';
import { EVENT_OFFER_LINKS, activateAllEventOffers } from './event-offers.js';

// Boss ke chaar offer links — panel/card me seedha button (koi link chhupa na rahe).
const OFFER_LINK_URLS = EVENT_OFFER_LINKS;
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import {
  getDb,
  saveDb,
  saveDbDurable,
  getDbIoStats,
  pruneDbForPerformance,
  flushDbSync,
  isBoss,
  addBoss,
  isServicePaused,
  setServicePaused,
  recordKnownUser,
  recordUserPhone,
  getUserLastDeliveryPhone,
  getAllBroadcastUserIds,
  setFamilyRole,
  getFamilyRole,
  getAccounts,
  updateAccount,
  createAccount,
  deleteAccount,
  getActiveUserOrder,
  getDraft,
  updateDraft,
  clearDraft,
  exportSessionJson,
  importSessionJson,
  normalizeSwiggySessionPayload,
  extractSwiggyAccountsListFromInput,
  getActiveOrderAccountKey,
  setActiveOrderAccountKey,
  permanentLogoutAccount,
  logoutAllAccounts,
  mutateDb,
  canTransitionOrder,
  getNextAutoUserName,
  cleanEssentialSwiggyCookies,
  hydrateAccountsFromCloudVault,
  syncCloudVaultNow,
  generateOrderId,
  isAccountLoggedInSession,
  findAccountKeyByPhone,
  cleanupDiskFilesForAccount,
  syncAccountsJsonMirror,
} from './store.js';
import { extractSharedUrls, stripSharedLinks, isLinkOnlyShareText } from './link-utils.js';
import { parseChatShareLinks, readChatHandoff, saveChatHandoffLinks } from './chat-miniapp-handoff.js';
import { restoreMoneyOnBoot, restoreIdentityOnBoot, startDbDurability, backupMoneyNow } from './db-durability.js';
import { submitBotWalletTopup, notifyPendingTopup, retryPendingTopupNotifications, retryPendingWalletUtrs } from './wallet-topup-service.js';
import { runDurabilityDoctor } from './durability-doctor.js';
import { recordStatementPayment, importStatementText } from './upi-statement.js';
import { isBossPayee, paymentStatusOk } from './upi-credit-policy.js';
import { fetchUtrPaymentDetails } from './utr-lookup.js';
import { describeUtrPayment } from './utr-truth.js';
import { isMenuText, isCommandText, looksLikePlainOrderId } from './menu-labels.js';
import {
  extractStandaloneMobileNumber,
  extractStandaloneOtpDigits,
  prepareNewSwiggyAccountIdentity,
  ingestAndPersistRawAccountTexts,
  formatBulkVaultImportSummaryHtml,
  createBulkDocumentBatchCollector,
  buildPortableAccountMessages,
} from './account-vault-intake.js';
import {
  validateUpiIntentForQr,
  buildFallbackUpiIntent,
  isPlaceholderUpiId,
  isValidUpiVpa,
  shouldReusePendingQr,
  describeQrRef,
  parseUpiIntent
} from './payment-qr-guard.js';
import { isAccountSuspended, markAccountHealthy, markAccountSuspended, describeSuspendedAccount, suspendedAccountsSummary, classifySwiggyAccountFailure } from './account-health.js';
import { diagnoseAccountOffers, fixAccountOffers, formatOfferDoctorReport, runOfferDoctorForAccount, OFFER_OPTIONS as DOCTOR_OFFER_OPTIONS } from './offer-claim-doctor.js';
import {
  autoExportAccountAfterDelivery,
  planDeliveryExport,
  isOrderDelivered,
  buildExportPayload
} from './delivery-release.js';
import {
  ACCOUNT_LOCK_TTL_MS,
  lockAccountToOrder,
  releaseAccountLock,
  accountLockOf,
  isAccountLockedForOtherOrder,
  lockedKeysForOtherOrders,
  sweepAccountLocks,
  planAccountReturnOnClose,
  lockStatusLine,
  isTerminalOrderStatus
} from './order-account-lock.js';
import {
  compactAccountListText,
  accountDetailText,
  liveOrderTruth,
  offerClaimTruth,
  fourOfferStatusBlock,
  fourOfferStatusLines,
  fourOfferScoreLine,
  OFFER_TRACKS,
  portableSessionJsonText,
  buildPortableSessionJson
} from './account-views.js';
import {
  DEVICE_LOGIN_STATUS,
  PLACEMENT_MODE,
  accountPhone as deviceAccountPhone,
  attachDeviceLogin,
  markHandoverSent,
  customerChoseOwnPhone,
  chooseBotPlacement,
  isCustomerPhonePlacement,
  markCustomerSaidLoggedIn,
  verifyAccountSessionLive,
  applySessionProbe,
  noteCustomerPlacedOrder,
  deviceLoginTruth,
  deviceLoginCallbacks,
  buildDeviceLoginHandover,
  buildDeviceLoginStatusText,
  buildDeviceLoginHelpText,
  placementHoldMessage,
  buildPhoneLoginCard,
  notePhoneCartSeen,
  notePhoneCartMissing
} from './customer-device-login.js';
import {
  serviceFeePaise,
  minTopupPaise,
  walletUpiId as configuredWalletUpiId,
  setWalletUpiId,
  submitTopupRequestWithLookup,
  TOPUP_PRESETS_PAISE,
  TOPUP_STATUS,
  rupees as walletRupees,
  ensureWallet,
  getWallet,
  walletBalancePaise,
  creditWallet,
  debitWallet,
  adjustWallet,
  setFeeExempt,
  chargeServiceFee,
  refundServiceFee,
  orderFeeState,
  isOrderPlaced,
  submitTopupRequest,
  validateUtr,
  findUsedUtr,
  markUtrUsed,
  approveTopupRequest,
  rejectTopupRequest,
  listTopupRequests,
  pendingTopupCount,
  searchWallets,
  walletVaultSummary,
  walletHistory,
  findOrderAwaitingFee,
  formatFeePayCard,
  formatTopupPayCard,
  formatWalletCard,
  formatOrderWalletCard,
  formatWalletHistory,
  formatBossWalletList,
  formatBossWalletUser,
  formatPendingUtrs,
  serviceFeePaiseFor,
  setServiceFeePaise,
  holdOrderQr,
  isOrderQrHeld,
  releaseOrderQr,
  feeControlSummary,
  formatFeeControlPanel,
  userFeeSummary,
  formatOrderVerificationCard,
  formatQrFailedCard,
  autoVerifyConfigured,
  recordDeferredFee,
  settleDeferredFee
} from './user-wallet.js';
import { normalizeIndianMobileNumber } from './phone-utils.js';
import { scanFailuresLine } from './scan-diagnostics.js';
import * as wafPool from './waf-pool.js';
import * as cart from './swiggy-cart.js';
import * as tracking from './order-tracking.js';
import { requestSwiggyOtpViaBridge, requestSwiggyDeleteOtpViaBridge, verifySwiggyOtpViaBridge, verifyAndDeleteSwiggyAccountViaBridge, signupSwiggyViaBridge, deactivateSwiggyAccountViaBridge, prewarmBrowser, checkLoggedInFromCookies, decodeJwtPayload, claimSwiggyBreakfastAndLateNightOffers, autoActivateEventOffers, EVENT_OFFER_OPTIONS, stripStaleWafCookie } from './swiggy-bridge.js';
import {
  getOrderCurrentTopic,
  buildTopicNavKeyboardRows,
  formatTopicProgressBarText,
  handleTopicNavClick,
  resetOrderTopicsToStart
} from './ammi-abbu-topic-flow.js';
import {
  isSimpleChatEnabled,
  buildSimpleHomeScreen,
  buildSimpleOrderCard,
  buildSimpleLoginHelpCard,
  buildSimpleTrackingMessage,
  buildConsentPatch,
  simpleTrackingUrl,
  SIMPLE_CHAT_CALLBACKS
} from './simple-chat.js';
import {
  verifyAndInspectSwiggyLink,
  inspectCartForAccount,
  getGenuinePaymentDetails,
  getStoredSwiggyTrackingUrl,
  isOfficialSwiggyTrackingUrl,
  isFabricatedTrackingUrl,
  normalizeSwiggyLiveOrderStatus,
  resolveSwiggyLink,
  fetchAccountAddresses,
  fetchAccountOrders,
  formatSwiggyWorldCartReceipt,
  captureSwiggyPaymentScreenshot,
  checkAccountFreeCash,
  claimInstamartFreeCash,
  fetchSwiggyProfileFromCookies,
  parseAddressDetails,
  parseLooseAddress,
  parseCartDetails,
  extractAddressShareUrl,
  isAddressShareUrl,
  syncGroupCartAndCheckoutForAccount,
  findBestMaxCouponAccountForOrder,
  applyMaxOfferToOrder,
  generatePersonalizedQrCard,
  generateUltraPremiumCard,
  reverseGeocodeCoords,
  isValidIndianDeliveryCoordinates,
  geocodeAddressDetails,
  fetchAllAccountsSavedAddresses,
  applyLiveCouponToOrder,
  verifySwiggySessionLive,
  inspectAccountOrderHistoryAndOffers,
  generateRealSwiggyMerchantUpiQr,
  checkRealSwiggyPaymentAndExtractTracking,
  extractTrackingViaAllAccounts,
  fetchSwiggyTrackingLinkFast,
  releaseSwiggyAccountReservation,
  startWafKeepWarmLoop,
  notePublicServiceOrigin,
  getPublicServiceBaseUrl,
  buildSignedOrderTrackUrl,
  dapiFetch,
  getCachedWafToken,
  invalidateAccountOrderProfileCache,
  getOfoResolutionFailureReason,
  clearOfoResolutionFailures
} from './swiggy-cart.js';
import {
  runMaintenance,
  getMaintenanceSnapshot,
  formatMaintenanceCard,
  startMaintenanceLoop,
  getEventLoopLagMs
} from './bot-maintenance.js';
import {
  extractForwardSenderInfo,
  looksLikeBossOrderInput,
  computeTrackHmac,
  formatBossDiagnosticErrorMessage,
  deleteOrderBotMessages,
  buildForwardedOrderCardView,
  dispatchAllReadyOrdersInParallel,
  handleBossForwardedOrderInput,
  registerForwardedOrderHandlers,
  executeRealQrGenerationForOrder,
  getPaymentPollerStats,
  startOrderDeliveryInfoPoller,
  sendOrderDeliveryInfoNotice,
  applyBossOrderUpdate,
  generateNamedUpiQrPngBuffer,
  sanitizeUpiUriForQr,
  sendBillSummaryToCustomerOnce,
  resolveBillSummaryAudience,
  resolveCustomerChatId,
  safeTelegramCaption,
  truncateDisplayField,
  lookupOrder,
  orderNotFoundDiag,
  stopOrderPaymentPoller,
  isQrGenerationInFlight
} from './forwarded-order-flow.js';
import {
  buildBossPanelHome,
  buildBossPendingList,
  buildBossOrderCard as formatBossOrderCard,
  buildBossArchiveList,
  buildBossCancelledList,
  buildBossDashboard,
  bossAlert,
  swiggyOrderIdOf,
  placedFromPhoneOf,
  trackingLinkDisplay,
} from './boss-panel.js';
import {
  ensureOrderTracking,
  startOrderTrackingAuto,
  PAYMENT_TRACKING_DELAYS,
  listActiveOrdersNeedingTracking,
  refreshActiveOrdersTracking,
  stopOrderTrackingAuto,
  setOrderTrackingNotifier,
  setOrderMilestoneNotifier,
  orderPlacedFromPhone,
  isTerminalDeliveryStatus,
  isCancelledOrRefusedStatus,
  resolveTrackEndpointPayload,
  adoptSwiggyOrderIdForBot,
  extractTrackingNow,
} from './order-tracking.js';
import {
  esc,
  heading,
  sub,
  field,
  bullet,
  section,
  card,
  table,
  divider,
  DIVIDER,
  message,
  otpSentCard,
  otpErrorCard,
  bossPanelCard,
} from './rich-text.js';

dotenv.config();

// Offline e2e suites import this file without secrets; in TEST_MODE we use a
// throw-away token instead of killing the process.
const IS_OFFLINE_TEST = String(process.env.TEST_MODE || '') === '1' || String(process.env.BOT_TEST_MODE || '') === '1';
const BOT_TOKEN = process.env.BOT_TOKEN || (IS_OFFLINE_TEST ? '123456:TEST-TOKEN-FOR-OFFLINE-E2E' : '');
// SECURITY FIX: BOSS_SECRET must be strong. Default 'boss123' is only allowed
// in TEST_MODE; in production we require an explicit secret and enforce
// minimum length + rate limiting on /boss attempts.
const BOSS_SECRET = process.env.BOSS_SECRET ||
  ((IS_OFFLINE_TEST || process.env.NODE_ENV !== 'production') ? 'boss123' : null);
const _bossAttemptMap = new Map(); // userId -> { count, firstTs, blockedUntil }

function _isBossSecretBlocked(userId) {
  const rec = _bossAttemptMap.get(String(userId));
  if (!rec) return false;
  if (rec.blockedUntil && Date.now() < rec.blockedUntil) return true;
  if (Date.now() - rec.firstTs > 15*60*1000) { _bossAttemptMap.delete(String(userId)); return false; }
  return false;
}
function _recordBossAttempt(userId, success) {
  const key = String(userId);
  if (success) { _bossAttemptMap.delete(key); return; }
  let rec = _bossAttemptMap.get(key);
  if (!rec || Date.now() - rec.firstTs > 15*60*1000) rec = { count: 0, firstTs: Date.now(), blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 5) rec.blockedUntil = Date.now() + 30*60*1000; // 5 fails = 30min block
  _bossAttemptMap.set(key, rec);
}

// Rate limiter for expensive callback scans (extract_now, lazy_confirm etc.)
// Prevents a single user spamming Swiggy API and triggering WAF/IP block.
const _scanRateMap = new Map(); // userId -> { count, windowStart }
function _isScanRateLimited(userId, maxPerWindow = 3, windowMs = 60_000) {
  const key = String(userId);
  const now = Date.now();
  let rec = _scanRateMap.get(key);
  if (!rec || now - rec.windowStart > windowMs) { rec = { count: 0, windowStart: now }; _scanRateMap.set(key, rec); }
  if (rec.count >= maxPerWindow) return true;
  rec.count += 1;
  return false;
}

if (!BOT_TOKEN) {
  console.error('× Error: BOT_TOKEN is missing in .env file!');
  process.exit(1);
}
if (!BOSS_SECRET || BOSS_SECRET.length < 6) {
  console.error('× Error: BOSS_SECRET must be set to a strong value (>=6 chars). Set it in .env or Railway Variables.');
  if (process.env.NODE_ENV === 'production') process.exit(1);
  else console.warn('⚠ Using default BOSS_SECRET=boss123 only because NODE_ENV!=production. Set a strong secret for production!');
}

const bot = installBossMirror(
  installBulletproofTelegramTransport(
    new Telegraf(BOT_TOKEN, {
      // 240s ka timeout matlab ek atka hua handler poore bot ko 4 minute block
      // kar deta tha ("Promise timed out after 240000 ms" spam + koi reply nahi).
      // 60s kaafi hai: har network kaam ka apna budget already hai.
      handlerTimeout: 60_000,
      telegram: {
        agent: createIpv4TelegramAgent()
      }
    })
  )
);

// Fix: Telegraf throws synchronously if answerCbQuery is called on a message update.
// All existing handlers assume .catch() is enough, but assert() throws before Promise.
// Monkey-patch to silently no-op when there's no callbackQuery (prevents UNEXPECTED_ERROR).
try {
  const _origAnswerCbQuery = bot.context?.answerCbQuery || null;
  if (_origAnswerCbQuery) {
    const patched = function(...args) {
      if (!this.callbackQuery) return Promise.resolve(true);
      return _origAnswerCbQuery.apply(this, args);
    };
    bot.context.answerCbQuery = patched;
    // Also patch prototype for any new contexts
    if (bot.context && bot.context.constructor && bot.context.constructor.prototype) {
      bot.context.constructor.prototype.answerCbQuery = patched;
    }
  }
  // Patch editMessageText to ignore benign "Message is not modified" races (Order Hub etc.)
  const _origEditText = bot.telegram.editMessageText.bind(bot.telegram);
  bot.telegram.editMessageText = async (chatId, messageId, inlineMessageId, text, extra) => {
    try {
      return await _origEditText(chatId, messageId, inlineMessageId, text, extra);
    } catch (e) {
      const msg = String(e?.message || e?.description || '');
      if (msg.toLowerCase().includes('message is not modified') || msg.toLowerCase().includes('message_id_invalid')) {
        return { ok: true };
      }
      throw e;
    }
  };
} catch {}

// ================= MANDATORY CHANNEL SUBSCRIPTION GATE & SERVICE PAUSE =================
// Requires all non-boss users to join @its_NoooB before using any bot features.
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  // Record user activity into knownUsers inventory for announcements & broadcast
  recordKnownUser(ctx.from);

  // Boss is unconditionally exempt from service pause and channel gate
  if (isBoss(userId)) return next();

  // Allow boss login commands (/boss, /admin) through
  const msgText = String(ctx.message?.text || '').trim();
  if (msgText.startsWith('/boss') || msgText.startsWith('/admin')) {
    return next();
  }

  // Service pause check: if Boss turned service OFF, block customers and show pause notice
  if (isServicePaused()) {
    const db = getDb();
    const pauseNotice = db.config?.servicePausedNotice ||
      '🔴 <b>Service Abhi Band Hai</b>\n\n' +
      'Admin ne service temporary pause ki hui hai. Kripya thodi der baad try karein.\n\n' +
      '<i>Service resume hote hi aap order kar sakenge.</i>';

    if (ctx.callbackQuery) {
      return ctx.answerCbQuery('🔴 Service abhi band hai. Kripya thodi der baad try karein.', { show_alert: true }).catch(() => {});
    }
    return ctx.reply(pauseNotice, { parse_mode: 'HTML' }).catch(() => {});
  }

  // Allow the verification button callback to execute
  if (ctx.callbackQuery?.data === 'check_channel_joined') return next();

  // In offline automated test suites where ENFORCE_CHANNEL_GATE is not set, allow next()
  if (isTestRunner()) return next();

  const status = await checkUserChannelMembership(ctx.telegram || bot.telegram, userId);
  if (status.isMember) return next();

  // User is NOT a member: block access and present the Force-Join card
  const card = formatChannelJoinCard();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`⚠️ Please join ${card.channel} first!`, { show_alert: true }).catch(() => {});
    try {
      await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
    } catch {
      await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
    }
    return;
  }

  await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
});

bot.action('check_channel_joined', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return ctx.answerCbQuery().catch(() => {});

  clearChannelMemberCache(userId);
  const status = await checkUserChannelMembership(ctx.telegram || bot.telegram, userId, { bypassCache: true });

  if (status.isMember) {
    await ctx.answerCbQuery('✅ Thanks! Channel verified. You can use the bot now.', { show_alert: true }).catch(() => {});
    try { await ctx.deleteMessage().catch(() => {}); } catch {}

    // Present user welcome screen
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(
      '👋 <b>Welcome!</b> Your access is unlocked. Just send a <b>Cart link</b> + <b>Address link</b>, and the bot does the rest.',
      { parse_mode: 'HTML' }
    ).catch(() => {});
    const cardMsg = await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard }).catch(() => {});
    rememberUserCard(userId, cardMsg);
    return;
  }

  if (status.reason === 'ADMIN_REQUIRED') {
    return ctx.answerCbQuery(`⚠️ Make the bot an Administrator in ${getChannelGateState().username} so verification can work!`, { show_alert: true }).catch(() => {});
  }

  return ctx.answerCbQuery(`❌ You have not joined ${getChannelGateState().username} yet! Join it, then tap Check Joined.`, { show_alert: true }).catch(() => {});
});

const userWaitState = {};

// ---------------------------------------------------------------------------
// One live card per customer chat
// ---------------------------------------------------------------------------
// Ammi/Abbu used to get 3-4 bubbles per link ("verified & saved", "now paste
// the next one", the screen …). Instead we keep ONE card and edit it in place:
// when a link is accepted the customer's own message and the stale prompt
// bubbles are deleted, and the card is refreshed with the next step.
const userChatCards = new Map();

function userCardState(userId) {
  const key = String(userId || '');
  if (!userChatCards.has(key)) userChatCards.set(key, { messageId: null, promptIds: [] });
  return userChatCards.get(key);
}

function rememberUserCard(userId, message) {
  if (!userId || !message?.message_id) return;
  userCardState(userId).messageId = message.message_id;
}

function rememberUserPrompt(userId, message) {
  if (!userId || !message?.message_id) return;
  const state = userCardState(userId);
  if (message.message_id === state.messageId) return;
  state.promptIds.push(message.message_id);
}

// Deletes the customer's own message plus the old prompt bubbles. The live card
// is kept (and can be deleted explicitly when an order ends).
async function cleanupUserChat(telegram, chatId, userId, { deleteIncomingId = null, deleteCard = false } = {}) {
  const state = userCardState(userId);
  const safeDelete = async (messageId) => {
    if (!messageId || messageId === state.messageId) return;
    try { await telegram.deleteMessage(chatId, messageId); } catch {}
  };
  await safeDelete(deleteIncomingId);
  for (const id of state.promptIds) await safeDelete(id);
  state.promptIds = [];
  if (deleteCard && state.messageId) {
    try { await telegram.deleteMessage(chatId, state.messageId); } catch {}
    state.messageId = null;
  }
  return state;
}

// Telegram only opens the reply keyboard (and focuses the input) for a message
// that carries `force_reply`. We send exactly ONE such prompt, remember it, and
// delete it as soon as the link arrives — so the chat still ends with one card.
const LINK_PROMPTS = {
  cart: {
    text: '🟠 <b>Cart link</b> bhejein 👇',
    placeholder: 'Swiggy cart link paste karein...'
  },
  address: {
    text: '🟠 <b>Address link</b> ya Location bhejein 👇',
    placeholder: 'Address link paste karein ya Location bhejein...'
  }
};

async function promptForLink(ctx, userId, kind) {
  const spec = LINK_PROMPTS[kind];
  if (!spec) return null;
  const chatId = ctx.chat?.id || userId;
  const state = userCardState(userId);
  // Replace an older prompt instead of stacking them.
  for (const id of state.promptIds) {
    try { await ctx.telegram.deleteMessage(chatId, id); } catch {}
  }
  state.promptIds = [];
  try {
    const prompt = await ctx.reply(spec.text, {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: spec.placeholder
      }
    });
    rememberUserPrompt(userId, prompt);
    return prompt;
  } catch (err) {
    console.warn('[Prompt] force_reply failed:', err?.message || err);
    return null;
  }
}

// Refreshes the single card: edit in place when possible, otherwise post once.
// `deleteIncoming` removes the customer's pasted link message; `notice` shows a
// short toast instead of an extra chat bubble.
async function renderUserCard(ctx, userId, { deleteIncoming = false, notice = '' } = {}) {
  const chatId = ctx.chat?.id || userId;
  const telegram = ctx.telegram || ctx.tg;
  const incomingId = deleteIncoming ? (ctx.message?.message_id || null) : null;
  const state = await cleanupUserChat(telegram, chatId, userId, { deleteIncomingId: incomingId });

  let screen;
  try {
    screen = getUserScreen(userId, ctx.from || { id: userId });
  } catch (err) {
    console.error('[UserCard] render failed:', err?.message || err);
    return null;
  }

  // Notices are folded into the card itself: the whole point of this renderer is
  // ONE bubble per chat, so a text-triggered notice must never post a second one.
  const cardText = notice ? `${screen.text}\n\n<i>${notice}</i>` : screen.text;

  if (state.messageId) {
    try {
      await telegram.editMessageText(chatId, state.messageId, null, cardText, {
        parse_mode: 'HTML',
        ...screen.keyboard
      });
      if (notice && ctx.callbackQuery && ctx.answerCbQuery) await ctx.answerCbQuery(notice).catch(() => {});
      return state.messageId;
    } catch {
      // Card was deleted by the customer or is too old to edit -> post a fresh one.
      state.messageId = null;
    }
  }

  const sent = await ctx.reply(cardText, { parse_mode: 'HTML', ...screen.keyboard }).catch(() => null);
  if (sent?.message_id) {
    state.messageId = sent.message_id;
    if (notice && ctx.callbackQuery && ctx.answerCbQuery) await ctx.answerCbQuery(notice).catch(() => {});
  }
  return sent?.message_id || null;
}


// Never let a stray async rejection or an unexpected throw take the whole bot
// down (Telegram polling, order sync, Swiggy fetches all run concurrently).
// Every failure is logged with its stack so it can be fixed instead of being
// reported to users as "[AI-DIAG] UNEXPECTED_ERROR".
process.on('unhandledRejection', (reason) => {
  const text = reason?.stack || reason?.message || String(reason);
  console.error('× Unhandled promise rejection:', text);
});
process.on('uncaughtException', (err) => {
  const text = err?.stack || err?.message || String(err);
  console.error('× Uncaught exception (bot kept alive):', text);
});

const splitJsonChunks = {};

function extractAllLinks(text) {
  // Markdown / duplicated links are normalised to the bare URL by link-utils,
  // so `[link](link)` never turns into one broken url with text around it.
  return extractSharedUrls(text);
}

function extractLink(text) {
  const links = extractAllLinks(text);
  return links.length > 0 ? links[0] : null;
}

function normalizeDeliveryContact(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : '';
}

function isLinkString(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim().toLowerCase();
  return (
    s.startsWith('http://') ||
    s.startsWith('https://') ||
    s.startsWith('www.') ||
    s.includes('swiggy.com') ||
    s.includes('swig.gy') ||
    s.includes('onelink.me') ||
    s.includes('maps.google') ||
    s.includes('goo.gl') ||
    s.includes('maps.app.goo.gl') ||
    s.includes('t.me/')
  );
}

export function isValidSwiggyCartUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const s = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch (e) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const isSwiggyHost = host === 'swiggy.com' || host.endsWith('.swiggy.com') || host === 'swig.gy' || host === 'swiggy.onelink.me' || host.endsWith('.onelink.me');
  if (!isSwiggyHost) return false;

  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  const full = path + search;

  if (path === '/' || path === '') return false;

  // Never treat tracking links as cart links (r.swiggy.com / ofo/track)
  if (host === 'r.swiggy.com' || path.includes('/ofo/track') || path.includes('/track/') || full.includes('ofo/track')) {
    return false;
  }

  // IMPORTANT: Address links should NEVER be classified as cart links!
  // E.g. https://swiggy.onelink.me/JgkQ/52yat6op or ofo/address or /address
  if (path.includes('jgkq') || path.includes('address') || full.includes('ofo/address') || path.includes('y313q1wv')) {
    return false;
  }

  // Swiggy Onelink should only be treated as cart if it explicitly specifies cart/menu/restaurant/gc
  if (host.includes('onelink.me')) {
    return (
      full.includes('/gc/') ||
      full.includes('group-cart') ||
      full.includes('group_cart') ||
      full.includes('/cart') ||
      full.includes('/menu') ||
      full.includes('restaurant')
    );
  }

  return (
    full.includes('/gc/') ||
    full.includes('group-cart') ||
    full.includes('group_cart') ||
    full.includes('groupcartid') ||
    full.includes('/cart') ||
    full.includes('restaurant_id') ||
    (host === 'swig.gy' && path.length >= 4)
  );
}

export function isValidDeliveryAddressUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const s = urlStr.trim();
  let parsed;
  try {
    parsed = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch (e) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  const full = path + search;

  const isGoogleMaps = host === 'maps.app.goo.gl' ||
                       host === 'goo.gl' ||
                       host === 'maps.google.com' ||
                       (host.endsWith('.google.com') && (path.includes('/maps') || path.includes('/place')));

  // Swiggy mobile app share address format: https://swiggy.onelink.me/JgkQ/...
  // (bare `onelink.me/JgkQ/...` shares appear too, so accept the base host)
  const isSwiggyOneLink = (host === 'onelink.me' || host.endsWith('.onelink.me')) && path.length >= 3;
  // Swiggy web address URLs
  const isSwiggyWeb = (host === 'swiggy.com' || host.endsWith('.swiggy.com') || host === 'swig.gy') &&
                      (path.includes('address') || full.includes('ofo/address') || path.includes('y313q1wv') || path.includes('jgkq'));

  if (!isGoogleMaps && !isSwiggyOneLink && !isSwiggyWeb) return false;

  if (isGoogleMaps && (path === '/' || path === '/maps') && !parsed.search && !parsed.hash) {
    return false;
  }

  // Reject cart links if mistakenly passed
  if (path.includes('/gc/') || path.includes('group-cart') || path.includes('group_cart') || path.includes('/cart')) {
    return false;
  }

  return true;
}

function classifyLink(url) {
  if (isValidDeliveryAddressUrl(url)) return 'ADDRESS';
  if (isValidSwiggyCartUrl(url)) return 'CART';
  return 'UNKNOWN';
}

// User Bottom Menu - Simple mode keeps only what a customer needs:
// a fresh order, past orders, and the tracking-link retriever.
function getUserReplyKeyboard(draft = {}) {
  if (isSimpleChatEnabled()) {
    return Markup.keyboard([
      [{ text: '🛒 New Order', style: 'success' }],
      [
        { text: '📦 Orders Done', style: 'primary' },
        { text: '🔗 Extract Tracking Link', style: 'primary' }
      ]
    ]).resize();
  }
  const hasCart = Boolean(draft?.cart);
  const hasAddr = Boolean(draft?.address);
  const bothReady = hasCart && hasAddr;
  const cartLabel = hasCart ? '🟢 🛒 Cart ✓' : '🟠 🛒 Cart Link';
  const addrLabel = hasAddr ? '🟢 📍 Address ✓' : '🟠 📍 Address Link';
  return Markup.keyboard([
    [
      { text: cartLabel, style: hasCart ? 'success' : 'danger' },
      { text: addrLabel, style: hasAddr ? 'success' : 'danger' }
    ],
    [
      { text: '🚀 Send to Beta', style: bothReady ? 'success' : 'primary' }
    ],
    [
      { text: '📦 Orders Done', style: 'primary' },
      { text: '✖ Cancel Draft', style: 'danger' }
    ],
    [
      { text: '🔗 Extract Tracking Link', style: 'primary' }
    ]
  ]).resize();
}

// Boss Bottom Menu — all slot bot buttons + new Extract Tracking button
function getBossReplyKeyboard() {
  return Markup.keyboard([
    [
      { text: '★ Boss Panel' },
      { text: '▣ Pending Orders' }
    ],
    [
      { text: '📦 Orders Done' },
      { text: '🔗 Extract Tracking Link' }
    ],
    [
      { text: '▤ Order History' },
      { text: '× Cancelled Orders' }
    ],
    [
      { text: '🔄 Active Orders Tracking' }
    ]
  ]).resize();
}

bot.hears(['🔗 Extract Tracking Link', 'Extract Tracking Link', 'extract tracking', '/extract', '🔗 extract', '/extractlink', '/tracking'], async (ctx) => {
  userWaitState[ctx.from.id] = { action: 'waiting_boss_extract_tracking' };
  await ctx.reply(
    '🔗 <b>Extract Tracking Link — All IDs scan</b>\nSend the <b>Order ID</b> (e.g. <code>FWD9670</code>) or Swiggy Order ID. I will check every logged-in Swiggy ID for its tracking link.',
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Enter Order ID' } }
  );
});

// ---------------------------------------------------------------------------
// Order card renderer — compact Swiggy-style receipt:
//   Order Account / Your Cart / Delivering To / items / Bill Summary / To Pay
// Address data is ONLY ever the URL-resolved delivery details (never chat text).
// ---------------------------------------------------------------------------

const PLACEHOLDER_CITIES = /^(?:india|address|delivery|delivering|shared location|delivery address|order|billing|your|saved)$/i;

function cleanAddressLine(line) {
  return String(line || '')
    .replace(/(?:📱\s*)?(?:phone|mobile|tel|contact)\s*[:\-]?\s*\+?[\d\s\-]{10,}/gi, '')
    .replace(/\bOrder\s*Account\s*:.*$/gi, '')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
}

// Normalises an addressDetails object for display: drops placeholder cities,
// duplicate lines and any phone/account noise that may have leaked in earlier.
function normalizeAddressForDisplay(ad) {
  if (!ad || typeof ad !== 'object') return null;
  const out = { ...ad };
  const city = String(out.city || '').trim();
  out.city = city && !PLACEHOLDER_CITIES.test(city) ? city : '';

  if (out.mobile) {
    const digits = String(out.mobile).replace(/\D/g, '').slice(-10);
    out.mobile = digits.length === 10 ? digits : '';
  }

  const seen = new Set();
  const lines = String(out.address || '')
    .split(/\r?\n/)
    .map(cleanAddressLine)
    .filter(line => {
      if (!line) return false;
      if (/^(?:delivering\s*to|your\s*cart|select an available payment method)$/i.test(line)) return false;
      if (out.city && line.toLowerCase() === `${out.city} address`.toLowerCase()) return false;
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  out.address = lines.join('\n').trim();
  if (!out.address && !out.city && !out.lat) return null;
  return out;
}

export function formatUserOrderCardText(order, isBossView = false) {
  const db = getDb();
  const selectedAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  const accPhone = order.orderAccount || selectedAcc?.phone || selectedAcc?.mobile || null;
  const restName = order.restaurantName || order.restaurant || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : '');
  const ad = normalizeAddressForDisplay(order.addressDetails || parseAddressDetails(order.address));

  const blocks = [];

  // ---------- 1. ORDER ACCOUNT (Boss view only) ----------
  if (isBossView && accPhone) {
    blocks.push(`<b>Order Account:</b> <code>${esc(accPhone)}</code>`);
  }

  // ---------- 2. CART / RESTAURANT ----------
  if (restName) {
    blocks.push(`<b>Your Cart</b>\n<b>${esc(restName)}</b>`);
  }

  // ---------- 3. DELIVERY ADDRESS ----------
  const addrLines = [];
  if (ad && (ad.address || ad.city || ad.name || ad.mobile || ad.lat)) {
    addrLines.push('<b>Delivering To</b>');
    addrLines.push(`<b>${esc(ad.city ? `${ad.city} Address` : 'Delivery Address')}</b>`);
    if (ad.name) addrLines.push(esc(ad.name));
    if (ad.mobile) addrLines.push(esc(ad.mobile));
    if (ad.flat_no && ad.address && !ad.address.startsWith(ad.flat_no)) addrLines.push(esc(ad.flat_no));
    if (ad.address) addrLines.push(...ad.address.split('\n').map(line => esc(line)));
    if (ad.lat) addrLines.push(`Latitude: ${esc(String(ad.lat))}`);
    if (ad.lng) addrLines.push(`Longitude: ${esc(String(ad.lng))}`);
    // NOTE: the card used to advertise a fake private mode and automatic
    // address wipe here. Neither feature exists: nothing purges db.orders on a
    // timer and saved addresses are never deleted, so those claims only scared
    // customers into thinking their order history would vanish. Do not add them
    // back — the card shows the delivery address and nothing else.
  } else if (order.addressDetails?.unresolvableShortLink) {
    addrLines.push('<b>Delivering To</b>');
    addrLines.push('<i>Address link could not be resolved — send a fresh address link or GPS pin.</i>');
  } else {
    addrLines.push('<b>Delivering To</b>');
    addrLines.push('<i>Address pending / share the Swiggy address link or a GPS pin.</i>');
  }
  blocks.push(addrLines.join('\n'));

  // ---------- 4. ORDER ITEMS ----------
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length > 0) {
    const itemLines = [];
    for (const it of items) {
      const qty = Number(it.qty || it.quantity || 1);
      const price = Number(it.price || (it.lineTotal ? it.lineTotal / qty : 0)) || 0;
      const lineTotal = Number(it.lineTotal || Math.round(price * qty * 100) / 100) || 0;
      itemLines.push(`<b>${esc(it.name || 'Item')}</b>`);
      itemLines.push(`₹${price} × ${qty} = ₹${lineTotal}`);
      itemLines.push('');
    }
    const totalQty = items.reduce((sum, it) => sum + Number(it.qty || it.quantity || 1), 0);
    const itemsTotal = Number(order.itemTotal || order.subtotal || items.reduce((sum, it) => sum + (Number(it.lineTotal) || 0), 0));
    itemLines.push(`${totalQty} ${totalQty === 1 ? 'Item' : 'Items'} • Subtotal: ₹${itemsTotal}`);
    blocks.push(itemLines.join('\n').trim());
  }

  // ---------- 5. BILL SUMMARY (clean, consistent) ----------
  const billLines = [];
  const hasBill = Number(order.finalPayable || order.subtotal || 0) > 0;
  if (hasBill) {
    billLines.push('<b>Bill Summary</b>');
    billLines.push(`Items Total: ₹${Number(order.subtotal || order.itemTotal || 0)}`);

    const merchantOfferDisc = order.merchantTradeDiscount !== undefined
      ? Number(order.merchantTradeDiscount || 0)
      : Math.max(0, Math.round((Number(order.tradeDiscountTotal || 0) - Number(order.campaignFreeCash || 0)) * 100) / 100);
    if (merchantOfferDisc > 0) billLines.push(`Restaurant Offer Discount: −₹${merchantOfferDisc}`);

    if (order.couponCode && Number(order.discountAmount || 0) > 0) {
      billLines.push(`Coupon ${esc(order.couponCode)}: −₹${Number(order.discountAmount)}`);
    } else if (order.couponCode) {
      billLines.push(`Coupon ${esc(order.couponCode)}: not applied`);
    } else if (order.swiggyVerified) {
      billLines.push('Coupon: no eligible offer confirmed by Swiggy');
    }

    const freeCash = Number(order.freeCashApplied || 0);
    if (freeCash > 0) billLines.push(`Extra Discount ( Free Cash ): −₹${freeCash}`);

    const oneFee = Number(order.swiggyOneMembershipFee || 0);
    if (oneFee > 0) billLines.push(`Swiggy One Lite Membership: +₹${oneFee}`);

    const savedDel = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
    const isFreeDel = Number(order.deliveryFee || 0) <= 0 &&
      (order.swiggyOneApplied || savedDel > 0 || oneFee > 0 || order.freeDelivery);
    if (isFreeDel) {
      billLines.push('Free Delivery upto 7km');
      billLines.push(`Delivery Fee: FREE${savedDel > 0 ? ` (₹${savedDel} saved)` : ''}`);
    } else if (Number(order.deliveryFee || 0) > 0) {
      billLines.push(`Delivery Fee: ₹${Number(order.deliveryFee)}`);
    } else {
      billLines.push('Delivery Fee: FREE');
    }

    if (order.packingCharges > 0) billLines.push(`Packing Charges: ₹${Number(order.packingCharges)}`);
    if (order.taxesAndCharges > 0) billLines.push(`GST & Other Charges: ₹${Number(order.taxesAndCharges)}`);

    billLines.push('━━━━━━━━━━━━━━');
    if (Number(order.totalSavings || 0) > 0) {
      billLines.push(`Total Savings: ₹${Number(order.totalSavings)}`);
    }
    billLines.push(`<b>To Pay: ₹${Number(order.finalPayable || order.subtotal || 0)}</b>`);
    // Card & other payment options (new)
    billLines.push(`<i>Pay via UPI QR, Card, or Wallet on Swiggy</i>`);
    blocks.push(billLines.join('\n'));
  } else {
    blocks.push('<b>Bill Summary</b>\n<i>Calculating max coupon and final bill on Swiggy…</i>');
  }

  // ---------- 6. PAYMENT LINK ----------
  if (order.swiggyPaymentUrl) {
    blocks.push(`<b>Swiggy Payment:</b> <a href="${esc(order.swiggyPaymentUrl)}">Open official Swiggy payment (UPI / Card)</a>`);
  }

  return blocks.filter(Boolean).join('\n\n');
}

// Format User (Customer) Order Screen matching State Machine
export function formatUserOrderCard(order) {
  const buttons = [];
  let text = '';
  const officialTrackingUrl = getStoredSwiggyTrackingUrl(order);
  const currentTopic = getOrderCurrentTopic(order);
  const topicProgress = formatTopicProgressBarText(currentTopic);

  if (order.status === 'ACCEPTED' || order.status === 'COMPLETED') {
    const trackingLine = officialTrackingUrl
      ? `<b>Swiggy tracking:</b> <a href="${escapeHtml(officialTrackingUrl)}">Open tracking link</a>`
      : '… Swiggy tracking link aate hi yahan bhej diya jayega.';
    const otpLine = order.deliveryOtp
      ? `<b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';
    const partnerLine = order.deliveryBoyName
      ? `<b>Delivery Partner:</b> ${escapeHtml(order.deliveryBoyName)}`
      : '';
    const partnerPhoneLine = order.deliveryBoyMobile
      ? `<b>Call Partner:</b> <code>${escapeHtml(order.deliveryBoyMobile)}</code>`
      : '';
    const swiggyPhone = order.orderAccount || order.selectedAccountPhone || order.injectedSession?.phone || '';
    const accountLine = swiggyPhone
      ? `<b>Swiggy Account:</b> <code>${escapeHtml(swiggyPhone)}</code>`
      : '';
    const sessionLine = order.injectedSessionStatus === 'DELIVERED_RELEASED'
      ? '<b>Session:</b> <i>Auto-logged out & returned to vault</i>'
      : (order.injectedSession ? '<b>Session:</b> <i>Injected & live tracking</i>' : '');

    text += `${heading(`Order #${order.id} — Confirmed`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Order Status', [
        `<b>${escapeHtml(order.liveOrderStatus || 'Processing')}</b>`,
        partnerLine,
        partnerPhoneLine,
        accountLine,
        sessionLine,
        trackingLine,
        otpLine
      ].filter(Boolean).join('\n')) +
      `\n${field('Support', '@Its_life_001')}`;
    if (order.deliveryBoyMobile) buttons.push([{ text: `📞 Call Partner: ${order.deliveryBoyMobile}`, callback_data: `user_call_partner_${order.id}` }]);
    if (officialTrackingUrl) buttons.push([{ text: '📍 Open Swiggy Tracking', url: officialTrackingUrl, style: 'success' }]);
    if (order.swiggyPaymentUrl) buttons.push([{ text: '💳 Pay via Swiggy', url: order.swiggyPaymentUrl, style: 'primary' }]);
    buttons.push([
      { text: '↻ Refresh Status', callback_data: `user_refresh_status_${order.id}`, style: 'primary' },
      { text: '✖ Cancel Order', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }
    ]);
    buttons.push([Markup.button.url('Contact support', 'https://t.me/Its_life_001')]);
    buttons.push([{ text: '🛒 Naya Order Shuru Karein (Finish)', callback_data: 'topic_finish_and_start', style: 'success' }]);
    text = topicProgress + text;
    buttons.unshift(...buildTopicNavKeyboardRows(currentTopic, order.id));
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
    const isCancelled = order.status === 'CANCELLED';
    text += `${heading(`Order #${order.id} — ${isCancelled ? 'Cancelled' : 'Rejected'}`)}\n\n` +
      `${sub(isCancelled ? 'Yeh order cancel kar diya gaya hai. Naya order shuru karne ke liye neeche dabayein:' : 'Yeh order cancel/reject ho gaya hai. Naya order karne ke liye neeche dabayein:')}\n\n` +
      field('Support', '@Its_life_001');
    buttons.push([{ text: '🛒 Naya Order Karein', callback_data: 'user_back_to_main', style: 'primary' }]);
    buttons.push([Markup.button.url('Contact support', 'https://t.me/Its_life_001')]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
  }

  // PENDING state: show only the verified bill and payment action.
  if (order.paymentSentToUser && (order.swiggyPaymentUrl || order.customQrFileId || order.finalPayable)) {
    const amt = order.finalPayable ? `₹${order.finalPayable}` : 'amount shown on Swiggy';
    text += `${heading(`Payment Ready — Order #${order.id}`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Payment', `${heading(`Pay ${esc(amt)}`)}\n${sub('Pay karne ke baad Check payment status dabayein.')}`) +
      `\n${field('Support', '@Its_life_001')}`;

    if (order.swiggyPaymentUrl) buttons.push([{ text: '💳 Pay via Swiggy (UPI/Card)', url: order.swiggyPaymentUrl, style: 'success' }]);
    buttons.push([{ text: '✓ Check payment status', callback_data: `user_paid_status_${order.id}`, style: 'success' }]);
    if (order.customQrFileId) {
      buttons.push([{ text: '↻ Resend payment QR', callback_data: `user_resend_qr_${order.id}`, style: 'primary' }]);
    } else if (order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.swiggyPaymentUrl) {
      buttons.push([{ text: '↻ Resend Swiggy payment details', callback_data: `user_resend_approved_qr_${order.id}`, style: 'primary' }]);
    }
  } else if (order.status === 'APPROVAL_PENDING' && !order.billApprovedByUser) {
    // The max-discount bill summary was sent; the QR is created only after approval.
    text += `${heading(`Bill summary sent (#${order.id})`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Confirm', `${heading('Bill check karke Approve karein')}\n${sub('Approve karte hi Swiggy payment QR aayega.')}`) +
      `\n${field('Support', '@Its_life_001')}`;
    buttons.push([{ text: '✓ Approve bill', callback_data: `user_approve_bill_${order.id}`, style: 'success' }]);
    buttons.push([{ text: '! Something is wrong', callback_data: `user_bill_issue_${order.id}`, style: 'danger' }]);
  } else if (Number(order.finalPayable || 0) > 0 && (order.selectedAccount || order.autoOptimized)) {
    // Auto max-offer finished: show the customer the verified bill while Boss approves.
    text += `${heading(`✓ Verified bill ready (#${order.id})`)}\n\n` +
      formatUserOrderCardText(order, false) + '\n\n' +
      section('Status', `${heading('Waiting for Beta approval')}\n${sub('Best offers lag chuke hain. Payment QR yahan aayega.')}`) +
      `\n${field('Support', '@Its_life_001')}`;
  } else if (order.cardStage === 'AUTO_SELECTING') {
    text += `${heading(`◷ Best offers check ho rahe hain (#${order.id})`)}\n\n` +
      section('Order details', [
        field('Restaurant', esc(order.restaurantName || 'Swiggy Food Order')),
        field('Status', '<b>Best offer lagaya ja raha hai</b>')
      ].join('\n')) +
      `\n${sub('Final bill yahan update ho jayega.')}`;
  } else {
    const rest = order.restaurantName || (order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : 'Swiggy Food Order');
    const ad = order.addressDetails || parseAddressDetails(order.address);
    const cleanAddr = ad?.address
      ? `${ad.address.slice(0, 50)}${ad.address.length > 50 ? '…' : ''}`
      : (ad?.city ? `${ad.city} Address` : (order.address ? 'Address attached' : 'Pending'));

    const diag = order.lastAccountError || order.autoOptimizeError || order.accountSyncError;
    const diagLine = diag ? `\n⚠️ <b>Dikkat:</b> <i>${esc(diag)}</i>\n` : '';

    text += `${heading(`↗ Order sent to Beta (#${order.id})`)}\n\n` +
      section('Order details', [
        field('Restaurant', esc(rest)),
        field('Delivering to', esc(cleanAddr)),
        field('Status', 'Checking best offer')
      ].join('\n')) +
      diagLine +
      `\n${sub('Bill aur payment QR yahan aayega.')}\n\n` +
      `${field('Support', '@Its_life_001')}`;
  }

  buttons.push([
    { text: '↻ Refresh status', callback_data: `user_refresh_status_${order.id}`, style: 'primary' },
    { text: '✖ Cancel order', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }
  ]);
  buttons.push([Markup.button.url('Contact support', 'https://t.me/Its_life_001')]);

  text = topicProgress + text;
  buttons.unshift(...buildTopicNavKeyboardRows(currentTopic, order.id));

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// Format Detailed Account Review Card for Boss (Address History, Order Items, Coupons, Final Charges & Payment)
function formatBossAccountReviewCard(order) {
  const db = getDb();
  const acc = db.config?.accounts?.[order.selectedAccount];
  const accPhone = order.orderAccount || acc?.phone || acc?.mobile || 'Selected Account';
  const accName = acc?.name || accPhone;

  let text = `${heading(`◉ [ SWIGGY ACCOUNT: ${esc(accName)} (${esc(accPhone)}) ]`)}` +
    `\n${heading(`▣ Order #${order.id} Review & Approval`)}`;

  const ad = order.addressDetails || parseAddressDetails(order.address);

  // ---------- 1. ADDRESS HISTORY & TARGET DELIVERY ----------
  let addrBody = '';
  if (ad && (ad.address || ad.city || ad.name)) {
    addrBody += `⌖ <b>Target delivery:</b> ${esc(ad.address || ad.city || '')}${ad.name ? ` (${esc(ad.name)})` : ''}\n`;
  } else if (order.address) {
    addrBody += `↗ <b>Address Link:</b> <code>${esc(order.address)}</code>\n`;
  }
  if (order.accountAddresses && order.accountAddresses.length > 0) {
    addrBody += `${sub(`Account Saved Addresses (${order.accountAddresses.length}):`)}\n`;
    order.accountAddresses.slice(0, 4).forEach((a, idx) => {
      const tag = a.annotation ? `[${a.annotation}] ` : '';
      addrBody += `  ${idx + 1}. ${esc(tag + a.address)}\n`;
    });
  } else {
    addrBody += `${sub('No prior saved addresses found on account. Target address will be used.')}\n`;
  }
  text += section('⌖ Address history & target delivery', addrBody);

  // ---------- 2. ORDER ITEMS (table inside border) ----------
  let itemsBody = `${esc(order.restaurantName || 'Swiggy Restaurant')}\n`;
  if (order.items && order.items.length > 0) {
    const rows = [['#', 'Item', 'Qty', 'Total']];
    order.items.forEach((it, idx) => {
      const total = it.lineTotal || (it.price * it.qty);
      rows.push([String(idx + 1), esc(it.name), String(it.qty || 1), `₹${total}`]);
    });
    itemsBody += table(rows);
    itemsBody += `${field('Subtotal', `₹${order.subtotal}`)}\n`;
  } else {
    itemsBody += `${sub('Items synced directly in Swiggy Cart / Group Order')}\n`;
  }
  text += section('▪ Verified order items', itemsBody);

  // ---------- 3. COUPON & OFFERS ----------
  let offersBody = '';
  if (order.couponCode && Number(order.discountAmount || 0) > 0) {
    offersBody += `✓ <b>Applied coupon:</b> <code>${esc(order.couponCode)}</code> (−₹${order.discountAmount})\n`;
  } else if (order.couponCode) {
    offersBody += `! <b>Coupon not applied:</b> <code>${esc(order.couponCode)}</code> (Swiggy confirmed ₹0 discount)\n`;
  } else {
    offersBody += `${sub(order.swiggyVerified ? 'No eligible coupon confirmed on this cart' : 'No coupon applied currently')}\n`;
  }
  if (order.availableCoupons && order.availableCoupons.length > 0) {
    const topCoupons = order.availableCoupons.slice(0, 5).map(c => c.code).join(', ');
    offersBody += `${field('Available on Account', `<code>${esc(topCoupons)}</code>`)}\n`;
  }
  text += section('◇ Coupon & offers', offersBody);

  // ---------- 4. FINAL BILL (table inside border) ----------
  const billRows = [['Final Bill', '']];
  billRows.push(['Items Total', `₹${order.subtotal || 0}`]);
  if (order.tradeDiscountTotal > 0) billRows.push(['Restaurant Offer Discount', `−₹${order.tradeDiscountTotal}`]);
  if (order.couponCode && order.discountAmount > 0) {
    billRows.push([`Coupon ${esc(order.couponCode)}`, `−₹${order.discountAmount}`]);
  }
  if (Number(order.swiggyOneMembershipFee || 0) > 0) {
    billRows.push(['Swiggy One Lite Membership', `+₹${order.swiggyOneMembershipFee}`]);
  }
  if (order.freeCashApplied > 0) billRows.push(['Swiggy Money / Free Cash', `−₹${order.freeCashApplied}`]);
  const revSavedDel = Number(order.freeDeliveryDiscount || order.deliverySaved || 0);
  const revIsFreeDel = Number(order.deliveryFee || 0) <= 0 && (order.swiggyOneApplied || revSavedDel > 0 || Number(order.swiggyOneMembershipFee || 0) > 0 || order.freeDelivery);
  if (revIsFreeDel) {
    billRows.push(['Free Delivery upto 7km', `Delivery Fee: FREE${revSavedDel > 0 ? ` (₹${revSavedDel} saved)` : ''}`]);
  } else if (Number(order.deliveryFee || 0) > 0) {
    billRows.push(['Delivery Fee', `₹${order.deliveryFee}`]);
  } else {
    billRows.push(['Delivery Fee', 'FREE']);
  }
  if (order.packingCharges > 0) billRows.push(['Packing Charges', `₹${order.packingCharges}`]);
  if (order.taxesAndCharges > 0) billRows.push(['GST & Other Charges', `₹${order.taxesAndCharges}`]);
  if (order.totalSavings > 0) billRows.push(['Total Savings', `₹${order.totalSavings}`]);
  billRows.push([`<b>Final Total</b>`, `<b>₹${order.finalPayable || order.subtotal || 0}</b>`]);
  text += section('₹ Final bill', table(billRows));

  // ---------- 5. OFFICIAL SWIGGY PAYMENT ----------
  let payBody = '';
  if (order.customQrFileId || order.qrBuffer) {
    payBody += `▣ Official payment QR: <b>Ready and captured</b>\n`;
  } else {
    payBody += `… Payment QR: <i>Pending / manual capture</i>\n`;
  }
  if (order.swiggyPaymentUrl) {
    payBody += `↗ Link: <a href="${esc(order.swiggyPaymentUrl)}">Open Swiggy Checkout</a>\n`;
  }
  if (order.paymentSentToUser) {
    payBody += `✓ <b>Status:</b> <b>Delivered to customer (awaiting payment)</b>`;
  } else {
    payBody += `! <b>Review the details above before sending the bill and payment QR.</b>`;
  }
  text += section('↗ Official Swiggy payment', payBody);

  const buttons = [];
  if (!order.paymentSentToUser) {
    buttons.push([
      Markup.button.callback('› Send Bill & Payment QR to Customer', `boss_send_qr_to_user_${order.id}`)
    ]);
  } else {
    buttons.push([
      Markup.button.callback('↻ Resend Bill & QR to Customer', `boss_send_qr_to_user_${order.id}`)
    ]);
  }
  buttons.push([
    Markup.button.callback('★ Auto Max Coupon (Best Acc)', `boss_auto_max_coupon_${order.id}`)
  ]);
  buttons.push([
    Markup.button.callback('↻ Switch Account', `boss_choose_acc_picker_${order.id}`),
    Markup.button.callback('# Change Coupon', `boss_coupon_picker_${order.id}`)
  ]);
  if (order.accountAddresses && order.accountAddresses.length > 0) {
    buttons.push([
      Markup.button.callback('⌖ Select Account Address', `boss_addr_picker_${order.id}`)
    ]);
  }
  buttons.push([
    Markup.button.callback('✓ Accept Order', `boss_action_accept_${order.id}`),
    Markup.button.callback('❌ Cancel Order', `boss_action_cancel_${order.id}`),
    Markup.button.callback('× Reject Order', `boss_action_sorry_${order.id}`)
  ]);
  buttons.push([
    Markup.button.callback('▣ View User QR Code', `boss_get_qr_${order.id}`),
    Markup.button.callback('← Back to Order Screen', `boss_back_to_order_${order.id}`)
  ]);

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

// Formats high-clarity OTP Send Failure Card with exact real diagnosis
function formatOtpSendErrorCard(phone, result = {}) {
  const reason = result.message || result.swiggyStatus || 'Swiggy could not confirm the OTP request.';
  const details = result.details || (result.status ? `HTTP ${result.status}` : '');
  const securityChallenge = result.code === 'SWIGGY_SECURITY_CHALLENGE';
  const rateLimited = result.code === 'SWIGGY_RATE_LIMIT';
  const blockedBySwiggy = securityChallenge || rateLimited;
  const hint = securityChallenge
    ? 'Swiggy controls this verification. Complete it in the official app/site and do not retry repeatedly.'
    : (rateLimited
        ? 'Wait for Swiggy’s limit to clear before making another OTP request.'
        : (result.retryable === true ? 'Wait briefly, then try once more if the issue continues.' : 'Check the number and Swiggy response before trying again.'));

  const text = otpErrorCard(phone, reason, hint)
    + (details ? `\n⌕ <i>Diagnostic Info: ${escapeHtml(details)}</i>\n` : '')
    + (blockedBySwiggy
        ? `\ni <i>Security checks and request limits are controlled by Swiggy. This bot will not bypass them. If you already have a valid session export for this account, use the JSON import option.</i>`
        : `\ni <i>If you have a valid Swiggy session export for this account, you can import it instead.</i>`);

  const buttons = blockedBySwiggy
    ? [
        [Markup.button.url('Open official Swiggy', 'https://www.swiggy.com/')],
        [Markup.button.callback('Paste Session JSON', 'boss_login_with_json'), Markup.button.callback('Main Menu', 'boss_panel_home')]
      ]
    : [
        ...(result.retryable === true ? [[Markup.button.callback('Retry OTP once', `resend_otp_${phone}`)]] : []),
        [Markup.button.callback('Enter Number Again', 'send_to_another_number')],
        [Markup.button.callback('Paste Session JSON', 'boss_login_with_json'), Markup.button.callback('Main Menu', 'boss_panel_home')]
      ];

  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}
// SIMPLE MODE: the card follows the customer's current order (bill -> pay ->
// tracking) instead of dropping them back to the link screen mid-order.
function getSimpleFocusOrder(userId) {
  const idNum = Number(userId);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const orders = Object.values(getDb().orders || {})
    .filter((o) => o && Number(o.userId) === idNum)
    .filter((o) => !['CANCELLED', 'REJECTED'].includes(String(o.status || '')))
    // "🏁 Finish" dismisses the finished card so it never reappears on /start.
    .filter((o) => !o.simpleCardDismissed)
    .filter((o) => {
      const created = new Date(o.createdAt || o.paidAt || 0).getTime();
      return Number.isFinite(created) && created >= since;
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const live = orders.find((o) => !['COMPLETED'].includes(String(o.status || '')));
  if (live) return live;
  const withTracking = orders.find((o) => simpleTrackingUrl(o));
  return withTracking || null;
}

// User Screen Generator - Short, direct single-card UI with colorful orange buttons (no slots)
function getUserScreen(userId, user) {
  const simpleMode = simpleChatForUser(userId);
  const activeOrder = simpleMode ? (getActiveUserOrder(userId) || getSimpleFocusOrder(userId)) : getActiveUserOrder(userId);
  if (activeOrder) {
    return simpleMode ? buildSimpleOrderCard(activeOrder) : formatUserOrderCard(activeOrder);
  }

  const draft = getDraft(userId);
  if (draft.miniAppLinks) return chatHandoffCard(readChatHandoff(userId));
  if (simpleMode) return buildSimpleHomeScreen(draft);
  const hasCart = Boolean(draft.cart);
  const hasAddr = Boolean(draft.address);
  const bothReady = hasCart && hasAddr;

  const cartBtn = hasCart
    ? { text: '🟢 🛒 Cart ✓', callback_data: 'action_add_cart', style: 'success' }
    : { text: '🟠 🛒 Cart Link', callback_data: 'action_add_cart', style: 'danger' };
  const addressBtn = hasAddr
    ? { text: '🟢 📍 Address ✓', callback_data: 'action_add_address', style: 'success' }
    : { text: '🟠 📍 Address Link', callback_data: 'action_add_address', style: 'danger' };

  const inlineButtons = [
    ...buildTopicNavKeyboardRows(1, 'draft'),
    [cartBtn, addressBtn],
    [{ text: '👤 Order for Someone Else', callback_data: 'action_order_for_others', style: 'primary' }],
    [{ text: '🚀 Send to Beta', callback_data: 'action_send_to_boss', style: bothReady ? 'success' : 'primary' }],
    [{ text: '👛 Wallet', callback_data: 'wallet_home', style: 'primary' },
     { text: '🆘 Admin', callback_data: 'support_contact_admin', style: 'primary' }],
    [
      { text: '📦 Previous Order', callback_data: 'action_previous_order', style: 'primary' },
      { text: '✖ Cancel', callback_data: 'action_cancel_order_confirm', style: 'danger' }
    ]
  ];

  const cd = draft.cartDetails || {};
  const itemRows = Array.isArray(cd.items) ? cd.items : [];
  const subVal = Number(
    cd.subtotal ||
    cd.itemsTotal ||
    itemRows.reduce((s, it) => s + Number(it.lineTotal || (Number(it.price || 0) * Number(it.qty || it.quantity || 1)) || 0), 0)
  );

  const shortUrl = (u) => {
    const clean = String(u || '').replace(/^https?:\/\/(?:www\.)?/i, '');
    return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean;
  };

  let cartLine = '🟠 <b>Cart:</b> Link bhejein';
  if (hasCart) {
    const restPart = cd.restaurantName
      ? `<b>${esc(cd.restaurantName)}</b>${subVal > 0 ? ` (₹${subVal})` : ''} · `
      : '';
    cartLine = `✓ <b>Cart:</b> ${restPart}<code>${esc(shortUrl(draft.cart))}</code>`;
    if (itemRows.length > 0) {
      const previewItems = itemRows.slice(0, 4).map((it) => {
        const q = Number(it.qty || it.quantity || 1);
        return `  • ${esc(it.name || 'Item')} × ${q}`;
      });
      if (itemRows.length > 4) previewItems.push(`  • +${itemRows.length - 4} more`);
      cartLine += `\n${previewItems.join('\n')}`;
    }
  }

  let addrLine = '🟠 <b>Address:</b> Link bhejein';
  if (hasAddr) {
    const ad = draft.addressDetails || {};
    if (ad.unresolvableShortLink) {
      // Honest label: the link is saved, but Swiggy never opened it.
      addrLine = '⚠️ <b>Address:</b> link added — Swiggy se khul nahi paya (↻ Retry karein)';
    }
    const addrUrl = draft.addressLink || (String(draft.address).startsWith('http') ? draft.address : '');
    const humanAddr = ad.address && !String(ad.address).startsWith('http')
      ? `${ad.address.slice(0, 45)}${ad.address.length > 45 ? '…' : ''}`
      : (!String(draft.address).startsWith('http') ? `${String(draft.address).slice(0, 45)}${String(draft.address).length > 45 ? '…' : ''}` : '');
    const parts = [];
    if (humanAddr) parts.push(esc(humanAddr));
    if (addrUrl) parts.push(`<code>${esc(shortUrl(addrUrl))}</code>`);
    addrLine = `✓ <b>Address:</b> ${parts.join(' · ') || 'Added'}`;
  }

  let nextLine = '';
  if (!hasCart && !hasAddr) {
    nextLine = '👉 Seedha <b>Cart</b> aur <b>Address link</b> bhejein 👇';
  } else if (hasCart && !hasAddr) {
    nextLine = '🟠 Ab <b>Address link</b> bhejein 👇';
  } else if (!hasCart && hasAddr) {
    nextLine = '🟠 Ab <b>Cart link</b> bhejein 👇';
  } else {
    nextLine = '🟢 <b>Dono links verified!</b> Ab <b>Send to Beta</b> dabayein 👇';
  }

  if (draft.addressDetails?.unresolvableShortLink) {
    nextLine += '\n⚠️ Naya <b>Address link</b> ya Location pin bhejein.';
  }

  const headerTitle = bothReady ? '🍽 <b>Topic 1: Order Ready!</b>' : '🍽 <b>Topic 1: Submit Link</b>';
  const text = `${headerTitle}\n\n${cartLine}\n${addrLine}\n\n${nextLine}`;

  return { text, keyboard: Markup.inlineKeyboard(inlineButtons) };
}

// Boss Panel Home — clean Apple-style panel (built in boss-panel.js)
function getBossPanelHome() {
  return buildBossPanelHome(getDb());
}

function getBossPanelText() {
  return buildBossPanelHome(getDb()).text;
}

function getBossPanelKeyboard() {
  return { reply_markup: buildBossPanelHome(getDb()).keyboard };
}

// ===== RARE TELEGRAM BUTTONS — jo bahut kam log jaante hain (ekdam alag type) =====
function makeCopyButton(label, value, fallbackCallback, style = 'primary') {
  if (value && value.length > 0 && value.length <= 256) {
    return { text: label, copy_text: { text: value }, style };
  }
  return { text: label, callback_data: fallbackCallback, style };
}

// Short values use Telegram's native copy button. Longer session exports are
// sent by the bot when the callback is tapped; no web page is required.
function makeFullSessionCopyButton(_ctx, label, accKey, fullValue, fallbackCallback, style = 'primary') {
  if (fullValue && fullValue.length > 0 && fullValue.length <= 256) {
    return { text: label, copy_text: { text: fullValue }, style };
  }
  return { text: label, callback_data: fallbackCallback || `copy_code_${accKey}`, style };
}

// Single card in-place updater for Boss and User
// ---------------------------------------------------------------------------
// Simple chat mode (customer side)
// ---------------------------------------------------------------------------
// Ammi/Abbu only need to paste TWO Swiggy links. Everything else is one tap.
// `SIMPLE_CHAT_MODE=0` restores the older multi-topic customer screens.
function simpleChatForUser(userId) {
  return isSimpleChatEnabled() && !isBoss(Number(userId));
}
function chatHandoffEnabled() {
  // Production link handoff is independent of the legacy screen theme. Offline
  // legacy suites opt out through TEST_MODE unless they explicitly enable it.
  return String(process.env.TEST_MODE || '') !== '1' || isSimpleChatEnabled();
}

function customerOrderCard(order, chatId = null) {
  if (!order) return null;
  // Decide by the CHAT being rendered: a boss-forwarded order still shows the
  // simple card to the customer it is delivered to.
  const targetId = Number(chatId || order.userChatId || order.userId || 0);
  if (isSimpleChatEnabled() && (!targetId || !isBoss(targetId))) {
    return buildSimpleOrderCard(order);
  }
  return formatUserOrderCard(order);
}

async function updateOrderCards(order, { skipUserCard = false, skipBossCard = false } = {}) {
  const db = getDb();
  const result = { bossCardUpdated: false, userCardUpdated: false };

  // 1. Update Boss card in-place
  if (!skipBossCard && order.bossMessageIds) {
    const bossCard = formatBossOrderCard(order);
    for (const [bossId, msgId] of Object.entries(order.bossMessageIds)) {
      try {
        await bot.telegram.editMessageText(
          bossId,
          msgId,
          null,
          bossCard.text,
          { parse_mode: 'HTML', ...bossCard.keyboard }
        );
        result.bossCardUpdated = true;
      } catch (e) {
        if (/message is not modified/i.test(String(e?.description || e?.message || ''))) {
          result.bossCardUpdated = true;
        }
      }
    }
  }

  // 2. Update User card in-place
  if (!skipUserCard && order.userChatId && order.userMessageId) {
    const userCard = customerOrderCard(order, order.userChatId);
    try {
      await bot.telegram.editMessageText(
        order.userChatId,
        order.userMessageId,
        null,
        userCard.text,
        { parse_mode: 'HTML', ...userCard.keyboard }
      );
      result.userCardUpdated = true;
    } catch (e) {
      if (/message is not modified/i.test(String(e?.description || e?.message || ''))) {
        result.userCardUpdated = true;
      }
    }
  }
  return result;
}

// Boss must also see the max-discount bill summary for customer orders. Usually
// the existing Boss card is just edited; if that card is gone, ONE compact
// summary message is posted (tracked so it is never repeated).
async function ensureBossBillSummary(order) {
  const db = getDb();
  const bossIds = [...new Set((db.config?.bossIds || []).filter(Boolean).map(String))];
  const sentTo = order.billSummarySentTo && typeof order.billSummarySentTo === 'object' ? order.billSummarySentTo : {};
  let posted = false;
  for (const bossId of bossIds) {
    if (sentTo[bossId]) continue;
    const hasLiveCard = Boolean(order.bossMessageIds?.[bossId]);
    // Prefer updating the live card; it is the single card for that Boss.
    if (hasLiveCard) {
      try {
        const card = formatBossOrderCard(order);
        await bot.telegram.editMessageText(bossId, order.bossMessageIds[bossId], null, card.text, {
          parse_mode: 'HTML',
          ...card.keyboard
        });
        sentTo[bossId] = new Date().toISOString();
        continue;
      } catch {}
    }
    const summaryText =
      `▤ <b>Bill summary · Order #${escapeHtml(order.id)}</b>\n` +
      `◉ <b>For:</b> ${escapeHtml(order.fwdSenderName || order.userName || 'Customer')}\n` +
      `▤ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy')}\n` +
      `₹ <b>To pay:</b> ₹${Number(order.finalPayable || 0)}\n` +
      (order.couponCode ? `◎ <b>Best offer:</b> ${escapeHtml(order.couponCode)}\n` : '') +
      (order.orderAccount ? `● <b>Account:</b> <code>${escapeHtml(String(order.orderAccount))}</code>\n` : '') +
      `\n<i>Bill customer ko confirmation ke liye bhej diya gaya hai; QR unke confirm karne par jayega.</i>`;
    try {
      const sent = await bot.telegram.sendMessage(bossId, summaryText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('Refresh status', 'boss_refresh')]])
      });
      order.bossMessageIds = { ...(order.bossMessageIds || {}), [bossId]: sent?.message_id };
      sentTo[bossId] = new Date().toISOString();
      posted = true;
    } catch {}
  }
  order.billSummarySentTo = sentTo;
  const fresh = getDb();
  if (fresh.orders?.[order.id]) {
    fresh.orders[order.id] = { ...fresh.orders[order.id], billSummarySentTo: sentTo, bossMessageIds: order.bossMessageIds };
    saveDb(fresh);
  }
  return posted;
}

// The bill summary is rendered INTO the customer's single live card when it
// exists, so confirming the bill never adds another chat bubble.
async function deliverBillSummaryIntoSingleCard(order, _summary) {
  const uid = order?.userChatId || order?.userId;
  if (!uid) return false;
  const state = userChatCards.get(String(uid));
  const targetMessageId = order?.userMessageId || state?.messageId;
  if (!targetMessageId) return false;
  const preview = {
    ...order,
    status: 'APPROVAL_PENDING',
    uxStage: 'SCREEN_03_BILL_CONFIRMATION',
    billSummarySentAt: order.billSummarySentAt || new Date().toISOString(),
    userChatId: uid,
    userMessageId: targetMessageId
  };
  const res = await updateOrderCards(preview).catch(() => null);
  if (res?.userCardUpdated) {
    order.userChatId = uid;
    order.userMessageId = targetMessageId;
    rememberUserCard(uid, { message_id: targetMessageId, chat: { id: uid } });
    return true;
  }
  return false;
}

// Delete order card messages from all boss chats and customer chat
async function deleteOrderMessages(order) {
  if (!order) return;
  // 1. Delete all boss card messages
  if (order.bossMessageIds) {
    for (const [bossId, msgId] of Object.entries(order.bossMessageIds)) {
      try {
        await bot.telegram.deleteMessage(bossId, msgId);
      } catch (e) {}
    }
  }
  // 2. Delete user card message
  if (order.userChatId && order.userMessageId) {
    try {
      await bot.telegram.deleteMessage(order.userChatId, order.userMessageId);
    } catch (e) {}
  }
}

// Send authentic Swiggy payment details to User (NEVER synthetic fake upi://pay)
/** UPI intent URI me se payee VPA (caption me sach dikhane ke liye). */
function payeeVpaFromUpiUri(uri) {
  try {
    const m = /[?&]pa=([^&]+)/i.exec(String(uri || ''));
    return m ? decodeURIComponent(m[1]).trim() : '';
  } catch { return ''; }
}

async function sendPaymentQrToUser(order) {
  if (!order) return;
  const targetChat = order.userChatId || order.userId;
  if (!targetChat) return;

  // 1. Ensure personalized QR code with customer's Telegram name in center of QR
  if (!order.genuineQrBuffer && !order.customQrFileId && (order.finalPayable || order.subtotal)) {
    const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
    const db = getDb();
    // 🚫 Boss (30-10-2026): order ka QR Swiggy ka hi hoga — boss ki UPI se
    // banaya QR paisa boss ke account me le jata tha par Swiggy ka order unpaid
    // reh jata tha. Swiggy ka payment data nahi to QR nahi.
    const swiggyUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
    if (!swiggyUri) {
      console.warn(`[sendPaymentQrToUser] Swiggy payment data missing (#${order.id})`);
      order.qrBlockedReason = 'Swiggy ne payment QR nahi diya';
      saveDb(db);
      return;
    }
    const upiUri = sanitizeUpiUriForQr(swiggyUri);
    try {
      // Try ultra premium holographic card first (alag type ka card), fallback to classic
      let generatedBuf = null;
      try { generatedBuf = await generateUltraPremiumCard({ customerName: custDisplayName, restaurantName: order.restaurantName || 'Swiggy Food Order', amount: order.finalPayable || order.subtotal || 0, savings: order.totalSavings || 0, upiUrl: upiUri, orderId: order.id, address: order.addressDetails?.address || order.address || '', deliveryOtp: order.deliveryOtp || '' }); } catch(e){}
      if (!generatedBuf) generatedBuf = await generatePersonalizedQrCard({
        customerName: custDisplayName,
        restaurantName: order.restaurantName || 'Swiggy Food Order',
        amount: order.finalPayable || order.subtotal || 0,
        savings: order.totalSavings || 0,
        upiUrl: upiUri
      });
      if (generatedBuf) {
        order.genuineQrBuffer = generatedBuf;
        saveDb(db);
      }
    } catch (e) {
      console.warn('[sendPaymentQrToUser] Card generation fallback:', e.message);
    }
  }

  // 2. If genuine custom QR photo from Swiggy was uploaded by Boss OR captured by automation
  if (order.customQrFileId || order.genuineQrBuffer) {
    try {
      const payable = order.finalPayable ? `₹${order.finalPayable}` : 'As shown on Swiggy';
      const photoSource = order.customQrFileId || { source: Buffer.from(order.genuineQrBuffer) };
      const rarePayRow = [];
      const _otp = String(order.deliveryOtp||'').trim();
      if (_otp) rarePayRow.push({ text: `📋 Copy OTP ${_otp}`, copy_text: { text: _otp } });
      const _payUrl = String(order.swiggyPaymentUrl||'https://www.swiggy.com/payments');
      rarePayRow.push({ text: '💳 Pay Link', url: _payUrl.startsWith('http')? _payUrl : 'https://www.swiggy.com/payments' });
      await bot.telegram.sendPhoto(targetChat, photoSource, {
        caption: safeTelegramCaption(
          `● <b>Official Swiggy Payment QR (Order #${order.id})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Order', 120))}\n` +
          `₹ <b>Payable on Swiggy:</b> <b>${payable}</b>\n\n` +
          `<i>Scan this genuine Swiggy QR code in PhonePe / Google Pay / Paytm / BHIM to pay directly to Swiggy:</i>`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Check payment status', `user_paid_status_${order.id}`)],
          [{ text: '↗️ Share Order', switch_inline_query: `Order #${order.id} ${order.restaurantName||''}` }, { text: '👥 Share to Group', switch_inline_query_chosen_chat: { query: `order ${order.id}`, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true } }],
          rarePayRow,
          [{ text: `📋 Copy Order ${String(order.id).slice(-4)}`, copy_text: { text: String(order.id) } }, Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      });
      order.qrSent = true;
      order.qrDelivered = true;
      saveDb(getDb());
      // Recipient SMS is left to Swiggy; the bot does not send one.
      return;
    } catch (e) {
      console.error(`Failed to send custom QR photo: ${e.message}`);
    }
  }

  // 2. If genuine Swiggy payment URL was generated by Swiggy / Boss
  if (order.swiggyPaymentUrl) {
    try {
      const _rareUrlRow = [{ text: `📋 Copy Link`, copy_text: { text: String(order.swiggyPaymentUrl) } }, { text: '💳 Pay Link', url: String(order.swiggyPaymentUrl) }];
      await bot.telegram.sendMessage(
        targetChat,
        `₹ <b>Official Swiggy Payment Link (Order #${order.id})</b>\n\n` +
        `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
        (order.finalPayable ? `₹ <b>Amount:</b> ₹${order.finalPayable}\n\n` : '\n') +
        `↗ <b>Click to Pay Directly on Swiggy:</b>\n<a href="${escapeHtml(order.swiggyPaymentUrl)}">${escapeHtml(order.swiggyPaymentUrl)}</a>\n\n` +
        `<i>★ Yeh authentic link Swiggy payment page se generated hai. Payment ke baad [ Check payment status ] dabayein!</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('₹ Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)],
            [{ text: '↗️ Share Link', switch_inline_query: `${order.swiggyPaymentUrl}` }, { text: '👥 To Group', switch_inline_query_chosen_chat: { query: `pay ${order.id}`, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true } }],
            _rareUrlRow,
            [Markup.button.callback('Check payment status', `user_paid_status_${order.id}`)],
            [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
          ])
        }
      );
      order.qrSent = true;
      saveDb(getDb());
      return;
    } catch (e) {
      console.error(`Failed to send payment URL: ${e.message}`);
    }
  }

  // 3. If payment link/QR not yet ready from Swiggy, inform customer with real status (NO FAKE UPI QR!)
  try {
    await bot.telegram.sendMessage(
      targetChat,
      `◷ <b>Swiggy Payment Link / QR Processing (Order #${order.id})</b>\n\n` +
      `Beta aapka cart Swiggy par open karke maximum discount & coupons verify kar raha hai.\n` +
      `Swiggy payment page se authentic link/QR aate hi yahan turant bhej diya jayega.\n\n` +
      `› <b>Immediate Help:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('○ Refresh Status', `user_refresh_status_${order.id}`)],
          [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      }
    );
  } catch (e) {}
}

// Asynchronous Cart & Address Inspection (runs on order submission or manual refresh — resolves live Group Cart, geocodes address, and preloads saved account addresses)
async function triggerBackgroundCartFetch(orderId, { skipAccountScan = false } = {}) {
  const db = getDb();
  const order = db.orders[orderId];
  if (!order) return;

  console.log(`[AutoFetch] Starting live cart & address resolution for Order #${orderId}...`);

  // Helper to safely merge non-empty address fields without overwriting valid street/coords with blanks or shortlink placeholders
  const mergeAddressSafe = (target, incoming) => {
    if (!incoming || incoming.unresolvableShortLink) return target;
    const base = { ...(target || {}) };
    for (const [k, v] of Object.entries(incoming)) {
      if (v !== null && v !== undefined && v !== '' && k !== 'unresolvableShortLink') {
        base[k] = v;
      }
    }
    const normalizeAddressIdentity = value => String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('en-IN')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const previousAddress = normalizeAddressIdentity(target?.address);
    const incomingAddress = normalizeAddressIdentity(incoming.address);
    if (previousAddress && incomingAddress && previousAddress !== incomingAddress) {
      // A changed street/pin must not inherit a previous recipient, location, or saved-address ID.
      for (const key of ['id', 'name', 'mobile', 'flat_no', 'area', 'landmark', 'city', 'pincode', 'lat', 'lng', 'annotation']) {
        if (incoming[key] === null || incoming[key] === undefined || incoming[key] === '') delete base[key];
      }
      if (!isValidIndianDeliveryCoordinates(incoming.lat, incoming.lng)) {
        delete base.lat;
        delete base.lng;
      }
    }
    return base;
  };

  // 1. Parse & geocode address details from full original text + link
  const rawAddrInput = order.addressOriginalText || order.address || '';
  if (rawAddrInput) {
    const parsedAddr = parseAddressDetails(rawAddrInput);
    if (parsedAddr) {
      order.addressDetails = mergeAddressSafe(order.addressDetails, parsedAddr);
    }
    try {
      const addrMeta = await resolveSwiggyLink(rawAddrInput);
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        order.addressDetails = mergeAddressSafe(order.addressDetails, addrMeta.addressDetails);
      }
      if (addrMeta?.ofoUser && !order.addressDetails?.name) {
        order.addressDetails = { ...(order.addressDetails || {}), name: addrMeta.ofoUser };
      }
    } catch (e) {}
  }

  if (order.addressDetails) {
    try {
      order.addressDetails = await geocodeAddressDetails(order.addressDetails);
      if (order.addressDetails?.address && (!order.address || order.address.startsWith('http'))) {
        order.addressLink = order.addressLink || (order.address?.startsWith('http') ? order.address : null);
        order.address = order.addressDetails.address;
      }
    } catch (e) {}
  }

  // Never blast all logged-in Swiggy accounts with `fetchAllAccountsSavedAddresses()` here:
  // querying 25-30 accounts simultaneously trips Swiggy's AWS WAF right before Auto Max Coupon runs,
  // and `syncGroupCartAndCheckoutForAccount` already returns `savedAddresses` for the chosen account!

  // 2. Resolve live Group Cart / Restaurant Menu / Personal Cart
  if (order.cart) {
    try {
      const cartMeta = await resolveSwiggyLink(order.cart);
      if (cartMeta?.restaurantId) order.restaurantId = cartMeta.restaurantId;
      if (cartMeta?.restaurantName) order.restaurantName = cartMeta.restaurantName;
      if (cartMeta?.hostName) order.hostName = cartMeta.hostName;
      if (cartMeta?.groupCartId) order.groupCartId = cartMeta.groupCartId;
      if (cartMeta?.groupCartStatus) order.groupCartStatus = cartMeta.groupCartStatus;

      if (cartMeta?.cartDetails) {
        const cd = cartMeta.cartDetails;
        if (cd.restaurantName) order.restaurantName = cd.restaurantName;
        if (cd.items && cd.items.length > 0) {
          order.items = cd.items;
          order.itemTotal = cd.itemsTotal || cd.subtotal || 0;
          order.subtotal = cd.subtotal || cd.itemsTotal || 0;
          if (cd.tradeDiscountTotal !== undefined) order.tradeDiscountTotal = cd.tradeDiscountTotal;
          if (cd.couponCode) { order.couponCode = cd.couponCode; order.discountAmount = cd.discountAmount || 0; }
          if (cd.swiggyOneMembershipFee > 0) order.swiggyOneMembershipFee = cd.swiggyOneMembershipFee;
          if (cd.freeCashApplied > 0) order.freeCashApplied = cd.freeCashApplied;
          if (cd.freeDelivery) {
            order.freeDelivery = true;
            order.swiggyOneApplied = true;
            order.freeDeliveryDiscount = cd.freeDeliveryDiscount || cd.deliverySaved || 0;
          }
          if (cd.packingCharges !== undefined) order.packingCharges = cd.packingCharges;
          if (cd.gstCharges !== undefined) order.taxesAndCharges = cd.gstCharges;
          if (cd.totalSavings > 0) order.totalSavings = cd.totalSavings;
          if (cd.finalPayable > 0) {
            order.finalPayable = cd.finalPayable;
            order.swiggyVerified = true;
          } else {
            order.swiggyVerified = false;
            applyMaxOfferToOrder(order);
          }
        }
      }

      // Auto-sync live Group Cart & apply Max Coupon when not followed immediately by `autoOptimizeUserOrder`
      if (!skipAccountScan && order.groupCartId && order.items?.length > 0 && !order.selectedAccount) {
        const bestRes = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false }).catch(() => null);
        if (bestRes?.availableCoupons?.length > 0) {
          order.availableCoupons = bestRes.availableCoupons;
        }
        if (bestRes?.savedAddresses?.length > 0 && (!order.accountAddresses || order.accountAddresses.length === 0)) {
          order.accountAddresses = bestRes.savedAddresses;
        }
      }

      // If no groupCartId items yet, check selected / active account personal cart when restaurant matches
      if ((!order.items || order.items.length === 0) && !order.groupCartId) {
        const targetKey = order.selectedAccount || getActiveOrderAccountKey(db);
        const targetAcc = db.config?.accounts?.[targetKey];
        if (targetAcc && (targetAcc.cookies || targetAcc.tid || targetAcc.jwtTid || targetAcc.token)) {
          const livePersonal = await inspectCartForAccount(targetAcc);
          if (livePersonal?.items?.length > 0 && (!order.restaurantId || String(livePersonal.restaurantId) === String(order.restaurantId))) {
            order.items = livePersonal.items;
            order.restaurantId = livePersonal.restaurantId || order.restaurantId;
            if (livePersonal.restaurantName) order.restaurantName = livePersonal.restaurantName;
            order.itemTotal = livePersonal.itemTotal;
            order.subtotal = livePersonal.subtotal;
            order.tradeDiscountTotal = livePersonal.tradeDiscountTotal || 0;
            order.deliveryFee = livePersonal.deliveryFee || 0;
            order.packingCharges = livePersonal.packingCharges || 0;
            order.taxesAndCharges = livePersonal.taxesAndCharges || 0;
            order.couponCode = livePersonal.couponCode || order.couponCode || null;
            order.discountAmount = livePersonal.discountAmount || 0;
            order.finalPayable = livePersonal.finalPayable;
            order.totalSavings = livePersonal.totalSavings;
            order.swiggyVerified = true;
          }
        }
      }
    } catch (e) {
      console.error(`[AutoFetch] Cart resolution error on Order #${orderId}:`, e.message);
    }
  }

  // 3. Clean fallback restaurant name only if still blank
  if (!order.restaurantName) {
    order.restaurantName = order.restaurantId ? `Swiggy Restaurant #${order.restaurantId}` : (order.hostName ? `${order.hostName}'s Group Order` : 'Swiggy Food Order');
  }

  const freshDb = getDb();
  const latestOrder = freshDb.orders?.[orderId] || {};
  const mergedOrder = {
    ...latestOrder,
    ...order,
    bossMessageIds: { ...(order.bossMessageIds || {}), ...(latestOrder.bossMessageIds || {}) },
    userMessageId: latestOrder.userMessageId || order.userMessageId || null,
    userChatId: latestOrder.userChatId || order.userChatId || null
  };
  freshDb.orders[orderId] = mergedOrder;
  saveDb(freshDb);
  await updateOrderCards(mergedOrder);
}

// ---------------------------------------------------------------------------
// AUTO MAX-OFFER FOR CUSTOMER SUBMISSIONS
// ---------------------------------------------------------------------------
// A forwarded message runs the full pipeline (best 0-Order account -> max coupon
// -> live bill) automatically. A customer tapping "Send to Beta" used to stop at a
// plain PENDING order, so Ammi had to wait for Boss to press "Auto Max Coupon".
// This helper gives customer orders the exact same treatment, in the background.
const autoOptimizeInFlight = new Set();

// SIMPLE MODE: the customer already tapped their one "Confirm" button. As soon
// as the max-offer bill is ready, turn that consent into the payment QR without
// asking them a second time.
async function autoApproveConsentedSimpleOrder(order) {
  try {
    if (!isSimpleChatEnabled()) return false;
    if (!order?.customerConsentGiven || order.billApprovedByUser) return false;
    if (String(order.status || '') !== 'APPROVAL_PENDING') return false;
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(order.status || ''))) return false;
    console.log(`[SimpleChat] Consent on Order #${order.id} -> generating payment QR`);
    const res = await approveUserOrderBillAction(String(order.userId || order.fwdSenderUserId || ''), order.id);
    return Boolean(res?.ok);
  } catch (err) {
    console.warn(`[SimpleChat] Auto-approve failed for #${order?.id}:`, err?.message || err);
    return false;
  }
}

export async function autoOptimizeUserOrder(orderId, { reason = 'CUSTOMER_SEND_TO_BETA' } = {}) {
  const key = String(orderId);
  if (autoOptimizeInFlight.has(key)) return { skipped: true, reason: 'in-flight' };
  autoOptimizeInFlight.add(key);

  try {
    let db = getDb();
    let order = db.orders?.[key];
    if (!order) return { skipped: true, reason: 'missing' };
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) return { skipped: true, reason: 'closed' };
    if (order.isForwardedOrder) {
      // Forwarded orders have their own pipeline (AUTO_SELECTING card flow).
      return { skipped: true, reason: 'forwarded' };
    }

    // No cart -> nothing to scan.
    if (!order.cart) {
      order.autoOptimizeError = 'Cart link missing — no account scan possible.';
      saveDb(db);
      await updateOrderCards(order).catch(() => {});
      return { skipped: true, reason: 'no-cart' };
    }

    // Background cart fetch may already have picked the best account + live bill.
    const hasVerifiedZeroBill = Boolean(
      order.swiggyVerified &&
      Number(order.subtotal || order.itemTotal || 0) > 0 &&
      order.finalPayable !== null &&
      order.finalPayable !== undefined &&
      Number(order.finalPayable) === 0
    );
    const alreadyPicked = Boolean(order.selectedAccount) && (Number(order.finalPayable || 0) > 0 || hasVerifiedZeroBill);
    if (alreadyPicked) {
      order.cardStage = 'BILL_READY';
      order.autoOptimized = true;
      order.autoOptimizedAt = order.autoOptimizedAt || new Date().toISOString();
      delete order.autoOptimizeError;
      saveDb(db);

      // Still send the one-time bill summary so the customer can confirm the QR.
      let summarySent = false;
      let summarySend = null;
      try {
        summarySend = await sendBillSummaryToCustomerOnce(bot.telegram, order, {
          db: getDb(),
          deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary)
        });
        summarySent = Boolean(summarySend?.sent);
      } catch (summaryErr) {
        console.warn('[AutoOptimize] Bill summary skipped:', summaryErr?.message || summaryErr);
      }

      order = getDb().orders?.[key] || order;
      const skipUserOnReuse = Boolean(summarySend?.viaCard || summarySend?.reason === 'already-sent');
      await updateOrderCards(order, { skipUserCard: skipUserOnReuse }).catch(() => {});
      if (summarySent) await ensureBossBillSummary(order).catch(() => {});
      await autoApproveConsentedSimpleOrder(order);
      return { success: true, reused: true, summarySent, order };
    }

    const statusBefore = order.status || 'PENDING';
    order.cardStage = 'AUTO_SELECTING';
    order.autoOptimizeStartedAt = new Date().toISOString();
    delete order.autoOptimizeError;
    saveDb(db);
    await updateOrderCards(order).catch(() => {});

    console.log(`[AutoOptimize] Order #${key} (${reason}): scanning accounts for max offer...`);
    const best = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: false });

    if (!best?.success) {
      db = getDb();
      order = db.orders?.[key] || order;
      order.cardStage = 'PENDING';
      order.status = statusBefore;
      order.autoOptimizeError = best?.error || 'Could not sync cart on any free Swiggy account.';
      order.autoOptimizeFailedAt = new Date().toISOString();
      db.orders[key] = order;
      saveDb(db);
      await updateOrderCards(order).catch(() => {});
      console.warn(`[AutoOptimize] Order #${key} failed: ${order.autoOptimizeError}`);
      return { success: false, error: order.autoOptimizeError, code: best?.code };
    }

    // CRITICAL: `getDb()` parses a fresh snapshot from disk on every call!
    // Never overwrite `order` (which `findBestMaxCouponAccountForOrder` just populated with
    // `selectedAccount`, `orderAccount`, `couponCode`, `finalPayable`, `items`, `addressDetails`!)
    // with the pre-scan disk object — merge concurrent card IDs into `order` and persist `order`!
    db = getDb();
    const diskOrder = db.orders?.[key] || {};
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(diskOrder.status)) {
      return { skipped: true, reason: 'closed' };
    }
    if (diskOrder.bossMessageIds) {
      order.bossMessageIds = { ...diskOrder.bossMessageIds, ...(order.bossMessageIds || {}) };
    }
    if (diskOrder.userMessageId && !order.userMessageId) order.userMessageId = diskOrder.userMessageId;
    if (diskOrder.userChatId && !order.userChatId) order.userChatId = diskOrder.userChatId;

    if (!order.selectedAccount && best.winningKey) order.selectedAccount = best.winningKey;
    if (!order.orderAccount && (best.winningAccount?.phone || best.winningKey)) {
      order.orderAccount = best.winningAccount?.phone || best.winningKey;
    }
    if (Array.isArray(best.savedAddresses) && best.savedAddresses.length > 0) order.accountAddresses = best.savedAddresses;
    if (Array.isArray(best.availableCoupons) && best.availableCoupons.length > 0) order.availableCoupons = best.availableCoupons;
    if (best.paymentUrl) order.swiggyPaymentUrl = best.paymentUrl;
    applyMaxOfferToOrder(order);
    injectAccountSessionIntoOrder(order, best.winningKey);

    // Keep the order in Boss's approval queue: only the bill/offers were computed.
    order.status = statusBefore;
    order.cardStage = 'BILL_READY';
    order.autoOptimized = true;
    order.autoOptimizedAt = new Date().toISOString();
    order.accountComparison = best.accountComparison || [];
    delete order.autoOptimizeError;
    db.orders[key] = order;
    saveDb(db);

    // 🔒 Ye ID ab SIRF is order ki — deliver/cancel tak kisi doosre order (Abbu ka
    // bhi) ko nahi milegi; aur wahi zero-order ID customer ke phone par handover
    // hoti hai taaki bill → QR → link → updates usi ID se chalein.
    try {
      const lockRes = await lockOrderAccountAndHandover(order, order.selectedAccount || best.winningKey, {
        telegram: bot.telegram,
        chatId: order.userChatId || order.userId
      });
      if (lockRes?.ok === false && lockRes?.code === 'ACCOUNT_LOCKED_FOR_OTHER_ORDER') {
        console.warn(`[AccountLock] ${lockRes.reason}`);
      }
      order = getDb().orders?.[key] || order;
    } catch (lockErr) {
      console.warn('[AccountLock] lock/handover failed:', lockErr?.message || lockErr);
    }

    // One-time max-discount bill summary -> customer approves -> QR is generated.
    let summarySent = false;
    let summarySend = null;
    try {
      summarySend = await sendBillSummaryToCustomerOnce(bot.telegram, order, {
        db: getDb(),
        deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary)
      });
      summarySent = Boolean(summarySend?.sent);
      if (summarySent) {
        console.log(`[AutoOptimize] Bill summary sent for Order #${key} -> ${summarySend.customerId}`);
      } else {
        console.warn(`[AutoOptimize] Bill summary not sent for Order #${key}: reason=${summarySend?.reason || 'unknown'}`);
      }
    } catch (summaryErr) {
      console.warn('[AutoOptimize] Bill summary skipped:', summaryErr?.message || summaryErr);
    }

    order = getDb().orders?.[key] || order;
    await updateOrderCards(order, { skipUserCard: Boolean(summarySend?.viaCard) }).catch(() => {});
    if (summarySent) await ensureBossBillSummary(order).catch(() => {});
    await autoApproveConsentedSimpleOrder(order);

    console.log(
      `[AutoOptimize] Order #${key} ready: account ${order.orderAccount || order.selectedAccount}, ` +
      `coupon ${order.couponCode || 'none'}, To Pay ₹${order.finalPayable || 0}` +
      `${summarySent ? ', bill summary sent' : ''}`
    );
    return { success: true, order, summarySent };
  } catch (err) {
    console.error(`[AutoOptimize] Order #${key} crashed:`, err?.stack || err?.message || err);
    try {
      const db = getDb();
      const order = db.orders?.[key];
      if (order) {
        order.cardStage = 'PENDING';
        order.autoOptimizeError = err?.message || 'Auto offer scan failed.';
        saveDb(db);
        await updateOrderCards(order).catch(() => {});
      }
    } catch (e) {}
    return { success: false, error: err?.message || String(err) };
  } finally {
    autoOptimizeInFlight.delete(key);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendSafeHtml(ctx, text, extra = {}) {
  const maxLen = 3800;
  if (!text || text.length <= maxLen) {
    if (ctx && typeof ctx.reply === 'function') {
      return ctx.reply(text, { parse_mode: 'HTML', ...extra });
    } else {
      const chatId = ctx?.chat?.id || ctx;
      return bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
    }
  }

  const parts = text.split('\n\n');
  const chunks = [];
  let cur = '';
  for (const part of parts) {
    if ((cur + '\n\n' + part).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = part;
    } else {
      cur = cur ? cur + '\n\n' + part : part;
    }
  }
  if (cur) chunks.push(cur);

  let lastMsg = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const opts = { parse_mode: 'HTML', ...(isLast ? extra : {}) };
    if (ctx && typeof ctx.reply === 'function') {
      lastMsg = await ctx.reply(chunks[i], opts);
    } else {
      const chatId = ctx?.chat?.id || ctx;
      lastMsg = await bot.telegram.sendMessage(chatId, chunks[i], opts);
    }
  }
  return lastMsg;
}

// Safe helper specifically for boss/user order cards (inline keyboards + long text)
async function sendCardSafe(chatIdOrCtx, card) {
  const { text, keyboard } = card;
  const isCtx = chatIdOrCtx && typeof chatIdOrCtx.reply === 'function';
  const safeTxt = text && text.length > 3800
    ? text.slice(0, 3740) + '\n\n<i>…(truncated)</i>'
    : text;
  if (isCtx) {
    return chatIdOrCtx.reply(safeTxt, { parse_mode: 'HTML', ...keyboard });
  }
  return bot.telegram.sendMessage(chatIdOrCtx, safeTxt, { parse_mode: 'HTML', ...keyboard });
}

async function sendPendingOrdersToBoss(bossId) {
  const db = getDb();
  const { header, cards } = buildBossPendingList(db);

  if (cards.length === 0) {
    await bot.telegram.sendMessage(bossId, '○ <i>No pending requests right now.</i>', { parse_mode: 'HTML' });
    return;
  }

  await bot.telegram.sendMessage(bossId, header, { parse_mode: 'HTML' });
  for (const card of cards) {
    await sendCardSafe(bossId, card);
  }
}

bot.action('boss_view_pending', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await sendPendingOrdersToBoss(ctx.from.id);
});

// View all Cancelled & Rejected Orders with full details
async function showCancelledOrders(ctx) {
  const db = getDb();
  const allOrders = Object.values(db.orders || {});
  const cancelledOrders = allOrders
    .filter(o => o.status === 'CANCELLED' || o.status === 'REJECTED')
    .sort((a, b) => new Date(b.cancelledAt || b.rejectedAt || b.createdAt || 0) - new Date(a.cancelledAt || a.rejectedAt || a.createdAt || 0));

  if (cancelledOrders.length === 0) {
    const emptyText = `× <b>Koi bhi Cancelled Order nahi mila!</b>\n\nAbhi tak koi order cancel ya reject nahi hua hai.`;
    if (ctx.callbackQuery) {
      return ctx.editMessageText(emptyText, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('← Back to Panel', 'boss_refresh')]])
      }).catch(async () => {
        await ctx.reply(emptyText, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
      });
    }
    return ctx.reply(emptyText, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  }

  // Show latest 10 cancelled orders
  const displayOrders = cancelledOrders.slice(0, 10);
  let text = section('× Cancelled Orders List', [
    field('Showing', `${displayOrders.length} of ${cancelledOrders.length}`),
  ]);

  for (const o of displayOrders) {
    const userProfileUrl = `tg://user?id=${o.userId}`;
    const userLink = `<a href="${userProfileUrl}">${esc(o.userName || 'Customer')}</a>`;
    const idLink = `<a href="${userProfileUrl}">${o.userId}</a>`;
    const timeStr = new Date(o.cancelledAt || o.rejectedAt || o.createdAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const rest = o.restaurantName || o.restaurant || 'N/A';
    const amt = o.finalPayable || o.amount || 0;

    const orderRows = [
      ['Order', `#${o.id} [${o.status}]`],
      ['Customer', `${userLink} (<code>${o.userId}</code>)`],
      ['Restaurant', esc(rest)],
      ['Amount', `₹${amt}`],
      ['Cancelled At', timeStr],
    ];
    if (o.cart) orderRows.push(['Cart', `<a href="${esc(o.cart)}">Open Cart Link</a>`]);
    if (o.address) orderRows.push(['Address', o.address.startsWith('http') ? `<a href="${esc(o.address)}">Open Address Link</a>` : `<code>${esc(o.address)}</code>`]);

    text += section(`▣ Order #${o.id} [${o.status}]`, table(orderRows));
  }

  const buttons = [
    [
      Markup.button.callback('↻ Refresh List', 'boss_view_cancelled_orders'),
      Markup.button.callback('← Back to Panel', 'boss_refresh')
    ]
  ];

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    } catch (e) {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    }
  } else {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard(buttons)
    });
  }
}

bot.action('boss_view_cancelled_orders', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showCancelledOrders(ctx);
});

bot.hears(['Cancelled Orders', '× Cancelled Orders', 'cancelled orders', '/cancelled'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showCancelledOrders(ctx);
});

// ================= SUCCESS ORDERS ARCHIVE =================

async function showSuccessOrdersArchive(ctx, selectedDate = null) {
  const db = getDb();
  const completedOrders = Object.values(db.orders || {})
    .filter(o => o.status === 'COMPLETED')
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0));

  if (completedOrders.length === 0) {
    const emptyText = `★ <b>Success Orders Archive</b>\n\n<i>Abhi tak koi successful order nahi hai.</i>`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback('← Back to Panel', 'boss_refresh')]]);
    if (ctx.callbackQuery) {
      return ctx.editMessageText(emptyText, { parse_mode: 'HTML', ...kb }).catch(() => ctx.reply(emptyText, { parse_mode: 'HTML', ...kb }));
    }
    return ctx.reply(emptyText, { parse_mode: 'HTML', ...kb });
  }

  // Group by Date string DD-MM-YYYY
  const dateMap = {};
  for (const o of completedOrders) {
    const dt = new Date(o.completedAt || o.createdAt || Date.now());
    const dStr = `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
    if (!dateMap[dStr]) dateMap[dStr] = [];
    dateMap[dStr].push(o);
  }

  const today = new Date();
  const todayStr = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
  const yest = new Date(Date.now() - 86400000);
  const yestStr = `${String(yest.getDate()).padStart(2, '0')}-${String(yest.getMonth() + 1).padStart(2, '0')}-${yest.getFullYear()}`;

  // If no date selected yet, ask "Which date of history do you wanna see?"
  if (!selectedDate) {
    const totalVolume = completedOrders.reduce((s, o) => s + (o.finalPayable || 0), 0);
    let text = section('★ Success Orders Archive', [
      sub('Which date of history do you wanna see?'),
      field('Total Completed Orders', `<code>${completedOrders.length}</code>`),
      field('Total Lifetime Volume', `<code>₹${totalVolume}</code>`),
      sub('Neeche diye gaye dates me se choose karein:'),
    ].join('\n'));

    const buttons = [];
    const dateKeys = Object.keys(dateMap).sort().reverse();
    for (const dKey of dateKeys) {
      let label = `◷ ${dKey} (${dateMap[dKey].length} orders)`;
      if (dKey === todayStr) label = `◷ Today (${dKey}) [${dateMap[dKey].length}]`;
      else if (dKey === yestStr) label = `◷ Yesterday (${dKey}) [${dateMap[dKey].length}]`;
      buttons.push([Markup.button.callback(label, `boss_archive_date_${dKey}`)]);
    }
    buttons.push([Markup.button.callback(`◎ All Dates (${completedOrders.length} orders)`, 'boss_archive_date_all')]);
    buttons.push([Markup.button.callback('← Back to Panel', 'boss_refresh')]);

    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }));
    }
    return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  // Display orders for the selected date
  const ordersToShow = selectedDate === 'all' ? completedOrders : (dateMap[selectedDate] || []);
  const title = selectedDate === 'all' ? 'All Dates' : selectedDate;
  const totalRev = ordersToShow.reduce((s, o) => s + (o.finalPayable || 0), 0);

  let text = `★ <b>Success Orders Archive — ${title}</b>\n` +
    `▤ <b>Total Orders:</b> ${ordersToShow.length} | ₹ <b>Total Volume:</b> ₹${totalRev}\n\n`;

  ordersToShow.slice(0, 10).forEach((o, idx) => {
    const accName = o.selectedAccount ? (db.config.accounts?.[o.selectedAccount]?.name || o.selectedAccount) : 'Default';
    const timeStr = new Date(o.completedAt || o.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const itemsStr = o.items && o.items.length ? o.items.map(i => `${esc(i.name)} x${i.qty || 1}`).join(', ') : 'Swiggy Food Items';
    text += section(`#${idx + 1}. [ #${o.id} ] — ₹${o.finalPayable || 0}`, [
      field('Customer', `<a href="tg://user?id=${o.userId}">${esc(o.userName || 'Customer')}</a> (<code>${o.userId}</code>)`),
      field('Restaurant', esc(o.restaurantName || 'Swiggy')),
      field('Items', esc(itemsStr)),
      field('Account', esc(accName)),
      field('Completed', timeStr),
    ].join('\n'));
  });

  if (ordersToShow.length > 10) {
    text += `<i>...and ${ordersToShow.length - 10} more orders.</i>\n`;
  }

  const buttons = [
    [Markup.button.callback('◷ Choose Another Date', 'boss_view_archive')],
    [Markup.button.callback('← Back to Panel', 'boss_refresh')]
  ];

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }));
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.action('boss_view_archive', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showSuccessOrdersArchive(ctx);
});

bot.action(/^boss_archive_date_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const dateKey = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  await showSuccessOrdersArchive(ctx, dateKey);
});

bot.hears(['Success Archive', '★ Success Archive', 'success archive', '/archive', 'Archive'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await showSuccessOrdersArchive(ctx);
});

// ================= COMMANDS =================

bot.start(async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  delete userWaitState[userId];

  const welcomeText = `👋 <b>Welcome!</b> Send your <b>Swiggy Cart link</b> and <b>Address link</b>, and we'll handle the rest. 👇`;

  // A new user must ALWAYS get a working screen. Any helper failure below is
  // contained here so /start can never surface an UNEXPECTED_ERROR to the user.
  try {
    if (isBoss(userId)) {
      await ctx.reply(`★ Welcome back, <b>Boss</b>! Swiggy Family Care Admin Mode is active.`, {
        parse_mode: 'HTML',
        ...getBossReplyKeyboard()
      });
      try {
        const home = getBossPanelHome();
        await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
        await sendPendingOrdersToBoss(userId);
      } catch (panelErr) {
        console.error('[START] boss panel render failed:', panelErr?.stack || panelErr?.message || panelErr);
      }
      return;
    }

    // SIMPLE CHAT MODE: no reply-keyboard clutter, no second bubble — just the
    // one card that asks for the two Swiggy links.
    if (simpleChatForUser(userId)) {
      const simpleScreen = getUserScreen(userId, ctx.from);
      const simpleMsg = await ctx.reply(
        '👋 <b>Welcome!</b> Just send your <b>Cart link</b> + <b>Address link</b> — the bot handles everything else.',
        { parse_mode: 'HTML' }
      ).catch(() => null);
      const cardMsg = await ctx.reply(simpleScreen.text, { parse_mode: 'HTML', ...simpleScreen.keyboard });
      rememberUserCard(userId, cardMsg);
      if (simpleMsg?.message_id && simpleMsg.message_id !== cardMsg?.message_id) {
        // Greeting is kept only as the very first line of the chat; the card is the screen.
        userCardState(userId).promptIds.push(simpleMsg.message_id);
      }
      return;
    }

    const draft = getDraft(userId);
    await ctx.reply(welcomeText, {
      parse_mode: 'HTML',
      ...getUserReplyKeyboard(draft)
    });

    try {
      const screen = getUserScreen(userId, ctx.from);
      const screenMsg = await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
      rememberUserCard(userId, screenMsg);
    } catch (screenErr) {
      console.error('[START] user screen render failed:', screenErr?.stack || screenErr?.message || screenErr);
      await ctx.reply('🟠 Send your <b>Cart</b> or <b>Address link</b> to get started 👇', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          { text: '🟠 🛒 Cart Link', callback_data: 'action_add_cart', style: 'danger' },
          { text: '🟠 📍 Address Link', callback_data: 'action_add_address', style: 'danger' }
        ]])
      }).catch(() => {});
    }
  } catch (err) {
    console.error('[START] handler failed:', err?.stack || err?.message || err);
    try {
      await ctx.reply(welcomeText, { parse_mode: 'HTML', ...getUserReplyKeyboard() });
    } catch (e2) {
      console.error('[START] fallback reply failed:', e2?.message || e2);
    }
  }
});

// Set an explicit HTTPS Mini App origin rather than trusting request Host
// headers or a guessed deployment URL.
function configuredMiniAppUrl(raw = process.env.PRO_MINIAPP_URL) {
  try {
    const url = new URL(String(raw || '').trim());
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || net.isIP(host)) return '';
    if (!/^\/pro\/?$/.test(url.pathname) || url.search || url.hash) return '';
    return url.toString();
  } catch { return ''; }
}

function chatHandoffCard(links = {}) {
  const cart = Boolean(links.cartUrl);
  const address = Boolean(links.addressUrl);
  const ready = cart && address;
  const url = configuredMiniAppUrl();
  const prompt = ready
    ? (url ? 'Mini App mein continue karein.' : 'Mini App configured nahi hai. Admin se baat karein.')
    : (!cart && !address ? 'Swiggy cart aur address links bhejein.' : !cart ? 'Ab cart link bhejein.' : 'Ab address link bhejein.');
  const rows = [];
  if (ready && url) rows.push([{ text: 'Open Mini App', web_app: { url } }]);
  rows.push([{ text: '👛 Wallet', callback_data: 'wallet_home' }]);
  return {
    text: `🛒 Cart ${cart ? '✓' : '—'}  ·  📍 Address ${address ? '✓' : '—'}\n${prompt}`,
    keyboard: { reply_markup: { inline_keyboard: rows } }
  };
}

async function showChatHandoff(ctx, entry) {
  const card = chatHandoffCard(entry);
  await ctx.reply(card.text, card.keyboard);
}

async function recordChatHandoffLinks(ctx, links) {
  const userId = ctx.from.id;
  try {
    const saved = saveChatHandoffLinks(userId, links);
    if (!saved.cartUrl) userWaitState[userId] = { action: 'waiting_miniapp_cart' };
    else if (!saved.addressUrl) userWaitState[userId] = { action: 'waiting_miniapp_address' };
    else delete userWaitState[userId];
    await showChatHandoff(ctx, saved);
    return true;
  } catch (err) {
    await ctx.reply(err?.message || 'Links save nahi hue. Dobara bhejein.');
    return false;
  }
}

async function askChatLinkKind(ctx, pending) {
  let label = 'Link';
  try { const u = new URL(pending.urls[0]); label = `${u.hostname}/…${u.pathname.slice(-6)}`; } catch {}
  // A different token for every link prevents an old button or a double tap
  // from classifying a later URL in the queue.
  pending.nonce = crypto.randomBytes(6).toString('hex');
  await ctx.reply(`${label}: cart hai ya address?`, {
    reply_markup: { inline_keyboard: [[
      { text: '🛒 Cart', callback_data: `mini_link_c:${pending.nonce}` },
      { text: '📍 Address', callback_data: `mini_link_a:${pending.nonce}` }
    ]] }
  });
}

bot.action(/^mini_link_([ca]):([a-f0-9]{12})$/, async (ctx) => {
  const pending = userWaitState[ctx.from.id];
  if (pending?.action !== 'classify_miniapp_link' || !pending.urls?.length || pending.nonce !== ctx.match[2]) {
    await ctx.answerCbQuery('Naya button use karein.').catch(() => {});
    return;
  }
  const kind = ctx.match[1] === 'c' ? 'cart' : 'address';
  pending.nonce = ''; // consume before the first await
  const current = pending.urls.shift();
  const duplicate = pending.links[kind] && pending.links[kind] !== current;
  if (!duplicate) pending.links[kind] = current;
  await ctx.answerCbQuery().catch(() => {});
  if (userWaitState[ctx.from.id] !== pending) return;
  if (duplicate) {
    delete userWaitState[ctx.from.id];
    await ctx.reply(`Do ${kind} links mile. Cart aur address alag se bhejein.`);
    return;
  }
  if (pending.urls.length) {
    pending.number += 1;
    await askChatLinkKind(ctx, pending);
    return;
  }
  await recordChatHandoffLinks(ctx, pending.links);
});

async function authorizeMiniAppUser(user) {
  if (isBoss(user.id)) return { allowed: true };
  if (isServicePaused()) return { allowed: false, message: 'Service is paused right now. Please try again later.' };
  if (isTestRunner()) return { allowed: true };
  const membership = await checkUserChannelMembership(bot.telegram, user.id);
  return membership.isMember
    ? { allowed: true }
    : { allowed: false, message: `Please join ${getChannelGateState().username} first, then tap Check Joined in the bot.` };
}

// Boss-only: change the required channel at runtime, no redeploy.
//   /channel            show status
//   /channel @name      require this channel (also accepts a t.me link)
//   /channel on|off     enable or disable the gate
bot.command('channel', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const arg = (parts[1] || '').toLowerCase();
  if (!arg) {
    const s = getChannelGateState();
    return ctx.reply(
      `📢 <b>Channel gate</b>\n` +
      `Status: <b>${s.enabled ? 'ON' : 'OFF'}</b>\n` +
      `Channel: <code>${escapeHtml(s.username)}</code>\n\n` +
      `<code>/channel @name</code> change channel\n` +
      `<code>/channel off</code> disable gate\n` +
      `<code>/channel on</code> enable gate`,
      { parse_mode: 'HTML' }
    );
  }
  try {
    if (arg === 'on' || arg === 'off') {
      const s = setChannelGate({ enabled: arg === 'on' });
      return ctx.reply(`✅ Channel gate is now <b>${s.enabled ? 'ON' : 'OFF'}</b>.`, { parse_mode: 'HTML' });
    }
    const s = setChannelGate({ username: parts[1], enabled: true });
    return ctx.reply(
      `✅ Required channel set to <code>${escapeHtml(s.username)}</code>. Gate is ON.\n` +
      `<i>Make sure the bot is an Administrator in that channel.</i>`,
      { parse_mode: 'HTML' }
    );
  } catch {
    return ctx.reply(
      '❌ Invalid channel. Use <code>/channel @username</code> or a <code>t.me/username</code> link.',
      { parse_mode: 'HTML' }
    );
  }
});

bot.command('pro', async (ctx) => {
  const url = configuredMiniAppUrl();
  if (!url) return ctx.reply('Mini App abhi configure nahi hai. Chat bot se order kar sakte hain.');
  // Boss (31-10-2026, round 3): "ACTUAL PAYMENT FLOW APPLY KAR." In-app UPI
  // payment default ON hai; band karne ke liye PRO_ENABLE_CHECKOUT=0.
  const checkoutNote = process.env.PRO_ENABLE_CHECKOUT === '0' || process.env.SWIGGY_BLOCK_LIVE_ORDER_PLACE === '1'
    ? 'App ke andar payment abhi band hai (server setting).'
    : 'Cart ke andar hi bill, UPI QR aur order status — order Swiggy se verify hota hai.';
  return ctx.reply(`Mini App kholo. Chat bot pehle ki tarah available hai. ${checkoutNote}`,
    Markup.inlineKeyboard([[Markup.button.webApp('🍽 Open App', url)]]));
});

bot.command('waf', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('⛔ Sirf Boss ye command use kar sakta hai.').catch(() => {});
  const s = wafPool.getSummary();
  const tokenLine = s.hasToken
    ? `▪ Token: <b>ACTIVE</b> — ${s.tokenAgeMin} min purana (source: ${s.source})`
    : (s.stale ? `▪ Token: <b>STALE</b> (${s.tokenAgeMin} min purana) — background refresh chal raha hai` : '▪ Token: abhi nahi mila — background fetch try hoga');
  await ctx.reply(
    '🛡 <b>WAF Status</b>\n\n' +
    tokenLine + '\n' +
    (s.cooldownMin > 0 ? `▪ Cooldown: <b>${s.cooldownMin} min</b> (scans paused, phir khud resume honge)` : '▪ Cooldown: nahi (scans active)'),
    { parse_mode: 'HTML' }
  );
});

// ---------------------------------------------------------------------------
// 🩺 MAINTENANCE (boss 30-10-2026: "bot ko maintenance kar jaldi se hang hogaya hai")
// ---------------------------------------------------------------------------
async function runMaintenanceForBoss(ctx, { dryRun = false } = {}) {
  const report = await runMaintenance({ cart, tracking }, { reason: 'BOSS_TAP', dryRun }).catch(() => null);
  const snapshot = getMaintenanceSnapshot();
  const text = [
    formatMaintenanceCard(snapshot),
    '',
    report ? `◉ <b>Abhi:</b> ${[
      report.locksReleased?.length ? `${report.locksReleased.length} lock free` : '',
      report.reservationsReleased?.length ? `${report.reservationsReleased.length} ID reservation free` : '',
      report.scansReset ? `${report.scansReset} scan reset` : ''
    ].filter(Boolean).join(' · ') || 'kuch atka nahi mila'}` : '⚠ Report nahi bana',
    dryRun ? '<i>(sirf check — kuch change nahi kiya)</i>' : ''
  ].filter(Boolean).join('\n');
  return { text, keyboard: { inline_keyboard: [[
    { text: '🧹 Clean Up Now', callback_data: 'boss_maintenance_heal', style: 'primary' },
    { text: '↻ Refresh', callback_data: 'boss_maintenance' }
  ], [
    { text: '★ Boss Panel', callback_data: 'boss_panel_home' }
  ]] } };
}

bot.command(['maintenance', 'maintain', 'heal'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  const out = await runMaintenanceForBoss(ctx, { dryRun: false });
  return ctx.reply(out.text, { parse_mode: 'HTML', reply_markup: out.keyboard }).catch(() => {});
});

bot.action('boss_maintenance', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const out = await runMaintenanceForBoss(ctx, { dryRun: false });
  await ctx.answerCbQuery('Maintenance checked').catch(() => {});
  return ctx.reply(out.text, { parse_mode: 'HTML', reply_markup: out.keyboard }).catch(() => {});
});

bot.action('boss_maintenance_heal', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const report = await runMaintenance({ cart, tracking }, { reason: 'BOSS_HEAL' }).catch(() => null);
  const freed = (report?.locksReleased?.length || 0) + (report?.reservationsReleased?.length || 0) + (report?.scansReset || 0);
  await ctx.answerCbQuery(freed > 0 ? `${freed} atki cheez free ki` : 'Kuch atka nahi tha').catch(() => {});
  const out = await runMaintenanceForBoss(ctx, { dryRun: true });
  return ctx.reply(out.text, { parse_mode: 'HTML', reply_markup: out.keyboard }).catch(() => {});
});

bot.command('help', async (ctx) => {
  const isBossUser = isBoss(ctx.from?.id);
  if (chatHandoffEnabled() && !isBossUser) {
    return ctx.reply('Send your Swiggy cart and address links. Then check your ID, address, cart and bill in the Mini App.');
  }
  const text =
    `🍽 <b>How to order</b>\n\n` +
    `1. 🟠 Send your <b>Cart link</b>\n` +
    `2. 🟠 Send your <b>Address link</b> (or share your location)\n` +
    `3. 🚀 Tap <b>Send to Beta</b>\n\n` +
    `<i>Stuck? Send /cancel to start over.</i>` +
    (isBossUser ? `\n\n★ Boss: <code>/boss</code> panel · <code>/parallel</code> ready orders · <code>/channel</code> join gate.` : '');
  return ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[
      { text: '🟠 🛒 Cart Link', callback_data: 'action_add_cart', style: 'danger' },
      { text: '🟠 📍 Address Link', callback_data: 'action_add_address', style: 'danger' }
    ]])
  });
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  delete userWaitState[userId];
  clearDraft(userId, { clearMiniAppLinks: true });
  if (isBoss(userId)) {
    const home = getBossPanelHome();
    return ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
  }
  return ctx.reply('✖ <b>Draft clear ho gaya.</b> Naya link bhejein 👇', {
    parse_mode: 'HTML',
    ...getUserReplyKeyboard()
  });
});

bot.command(['boss', 'admin'], async (ctx) => {
  try {
  const userId = ctx.from.id;
  const args = ctx.message.text.trim().split(' ');
  const password = args[1];

  // Rate limit + audit: prevent brute force on BOSS_SECRET
  if (_isBossSecretBlocked(userId)) {
    return ctx.reply('⛔ Too many failed attempts. Try again after 30 minutes.').catch(()=>{});
  }

  // Return Telegram buttons immediately; collect order inputs in chat.

  if (isBoss(userId)) {
    delete userWaitState[userId];
    await ctx.reply(`★ <b>Boss Mode Activated</b>`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
    await sendPendingOrdersToBoss(userId);
    return;
  }

  if (!BOSS_SECRET) {
    return ctx.reply('⛔ Boss authentication is disabled — BOSS_SECRET not configured on server.').catch(()=>{});
  }
  if (password === BOSS_SECRET) {
    _recordBossAttempt(userId, true);
    addBoss(userId);
    await ctx.reply(`✓ <b>Authorization successful!</b>`, {
      parse_mode: 'HTML',
      ...getBossReplyKeyboard()
    });
    const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
    await sendPendingOrdersToBoss(userId);
    return;
  }

  _recordBossAttempt(userId, false);
  await ctx.reply(`× <b>Access Denied:</b> Reserved for Boss only.`, { parse_mode: 'HTML' });
  } catch (e) { console.error('[boss] handler error:', e?.message||e); }
});

// ================= UPI ID CONFIGURATION =================

bot.command('setupi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    const db = getDb();
    const cur = String(db.config?.bossUpiId || '').trim() || '(set nahi hai)';
    return ctx.reply(`₹ Current Payment UPI ID: <code>${cur}</code>\n\nChange with: <code>/setupi yourname@upi</code>`, { parse_mode: 'HTML' });
  }
  const newUpi = parts[1].trim();
  // A QR built from a placeholder/invalid VPA always scans as "invalid".
  if (isPlaceholderUpiId(newUpi)) {
    return ctx.reply(
      `× <b>Ye UPI ID use nahi ho sakti:</b> <code>${escapeHtml(newUpi)}</code>\n` +
      `<i>Ye Swiggy ka / placeholder ID hai — is QR par payment kabhi nahi aayega (scan par &quot;invalid&quot;).</i>\n\n` +
      `Apni asli UPI bhejein, jaise <code>yourname@okaxis</code> ya <code>yourname@ybl</code>:\n<code>/setupi yourname@okaxis</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
  if (!isValidUpiVpa(newUpi)) {
    return ctx.reply(`× <b>UPI ID ka format galat hai:</b> <code>${escapeHtml(newUpi)}</code>\nSahi format: <code>name@bank</code> (jaise <code>rahul@okaxis</code>)`, { parse_mode: 'HTML' }).catch(() => {});
  }
  const db = getDb();
  db.config.bossUpiId = newUpi;
  saveDb(db);
  await ctx.reply(`✓ <b>Payment UPI ID updated to:</b> <code>${escapeHtml(newUpi)}</code>\nAb se generated QR par payment seedha is ID par aayega!`, { parse_mode: 'HTML' });
});

// Tap-to-set UPI (Boss ko "QR blocked" alert me milta hai)
bot.action('boss_set_payment_upi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const cur = String(getDb().config?.bossUpiId || '').trim();
  userWaitState[ctx.from.id] = { action: 'waiting_boss_upi' };
  await ctx.reply(
    `₹ <b>Payment UPI ID set karein</b>\n\n` +
    `▪ Abhi: ${cur ? `<code>${escapeHtml(cur)}</code>` : '<i>set nahi hai</i>'}\n\n` +
    `Apni asli UPI bhejein (jaise <code>name@okaxis</code> / <code>name@ybl</code>).\n` +
    `<i>Placeholder / Swiggy ke merchant ID reject ho jayenge — unse bana QR scan par invalid hota hai.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'Cancel', callback_data: 'boss_panel_home', style: 'primary' }]] }
    }
  ).catch(() => {});
});

// ================= BOSS SERVICE ON / OFF TOGGLE & BROADCAST =================

bot.action('boss_toggle_service', async (ctx) => {
  if (!isBoss(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const newPaused = !isServicePaused();
  setServicePaused(newPaused);
  const alertTxt = newPaused
    ? '🔴 Service is now PAUSED! Customers will see the offline notice.'
    : '🟢 Service is now ACTIVE! Customers can order normally.';
  await ctx.answerCbQuery(alertTxt, { show_alert: true }).catch(() => {});
  try {
    const home = getBossPanelHome();
    await ctx.editMessageText(home.text, { parse_mode: 'HTML', ...home.keyboard }).catch(() => {});
  } catch {}
});

bot.command(['service', 'toggle_service', 'pause_service', 'resume_service'], async (ctx) => {
  if (!isBoss(ctx.from?.id)) return ctx.reply('⛔ Sirf Boss ye command use kar sakta hai.').catch(() => {});
  const parts = ctx.message.text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/^\//, '');
  const subCmd = (parts[1] || '').toLowerCase();
  const customNotice = parts.slice(subCmd ? 2 : 1).join(' ').trim();

  let newPaused = false;
  if (cmd === 'pause_service' || subCmd === 'off' || subCmd === 'pause') {
    newPaused = true;
    setServicePaused(true, customNotice || null);
  } else if (cmd === 'resume_service' || subCmd === 'on' || subCmd === 'resume') {
    newPaused = false;
    setServicePaused(false);
  } else if (subCmd === 'status') {
    const p = isServicePaused();
    return ctx.reply(
      `📊 <b>Service Status:</b> ${p ? '🔴 <b>PAUSED (Offline)</b>' : '🟢 <b>ACTIVE (Online)</b>'}\n\n` +
      `Toggle karein: <code>/service on</code> ya <code>/service off</code>`,
      { parse_mode: 'HTML' }
    );
  } else {
    newPaused = !isServicePaused();
    setServicePaused(newPaused, customNotice || null);
  }

  const statusTxt = newPaused
    ? '🔴 <b>Service OFF kar di gayi hai (PAUSED).</b>\n\nAb koi bhi customer order ya link nahi bhej payega. Unhe pause notice dikhega.\nDobara ON karne ke liye: <code>/service on</code>'
    : '🟢 <b>Service ON kar di gayi hai (ACTIVE).</b>\n\nAb sabhi customers order kar sakte hain.\nOFF karne ke liye: <code>/service off</code>';

  await ctx.reply(statusTxt, { parse_mode: 'HTML' });
});

bot.action('boss_broadcast_prompt', async (ctx) => {
  const userId = ctx.from?.id;
  if (!isBoss(userId)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[userId] = { action: 'waiting_broadcast_message' };
  const allUsers = getAllBroadcastUserIds();
  await ctx.reply(
    `📢 <b>Broadcast Announcement</b>\n\n` +
    `Ab jo bhi text message aap agla bhejenge, wo bot ke <b>${allUsers.length}</b> users ko deliver hoga.\n\n` +
    `<i>Ya direct command use karein:</i>\n<code>/broadcast Aapka message yahan...</code>\n\n` +
    `<i>Cancel karne ke liye:</i> <code>/cancel</code>`,
    { parse_mode: 'HTML' }
  );
});

async function executeBroadcast(ctx, messageText) {
  const text = String(messageText || '').trim();
  if (!text) {
    return ctx.reply(
      '📢 <b>Broadcast Announcement</b>\n\n' +
      'Usage: <code>/broadcast Aapka message yahan...</code>\n\n' +
      'Ye message bot ke sabhi customers/users ko deliver hoga.',
      { parse_mode: 'HTML' }
    );
  }

  const allUsers = getAllBroadcastUserIds();
  if (allUsers.length === 0) {
    return ctx.reply('⚠️ Koi users nahi mile broadcast karne ke liye.');
  }

  const progressMsg = await ctx.reply(
    `📢 <i>Broadcasting message to <b>${allUsers.length}</b> users...</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => null);

  let sent = 0;
  let failed = 0;

  for (const targetId of allUsers) {
    try {
      await ctx.telegram.sendMessage(targetId, text, { parse_mode: 'HTML' });
      sent++;
    } catch {
      try {
        await ctx.telegram.sendMessage(targetId, text);
        sent++;
      } catch (err) {
        failed++;
        console.warn(`[Broadcast] Could not send to ${targetId}:`, err?.message || err);
      }
    }
    // Rate limit throttle: 35ms sleep
    await new Promise(r => setTimeout(r, 35));
  }

  const report =
    `✅ <b>Broadcast Completed!</b>\n\n` +
    `👥 <b>Total Users:</b> ${allUsers.length}\n` +
    `✓ <b>Delivered:</b> ${sent}\n` +
    (failed > 0 ? `× <b>Failed/Blocked:</b> ${failed}\n` : '') +
    `\n<i>Broadcast messages have been sent.</i>`;

  if (progressMsg?.message_id) {
    await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, report, { parse_mode: 'HTML' }).catch(async () => {
      await ctx.reply(report, { parse_mode: 'HTML' }).catch(() => {});
    });
  } else {
    await ctx.reply(report, { parse_mode: 'HTML' }).catch(() => {});
  }
}

bot.command(['broadcast', 'announce'], async (ctx) => {
  if (!isBoss(ctx.from?.id)) return ctx.reply('⛔ Sirf Boss ye command use kar sakta hai.').catch(() => {});
  const msgText = ctx.message.text.replace(/^\/(?:broadcast|announce)(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();
  await executeBroadcast(ctx, msgText);
});

bot.action('boss_prompt_set_upi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
  const db = getDb();
  const cur = String(db.config?.bossUpiId || '').trim() || '(set nahi hai)';
  await ctx.reply(
    `₹ <b>Enter your UPI ID (VPA):</b>\n\nCurrent: <code>${cur}</code>\n\n<i>Chat me apna UPI ID likh kar bhejein (jaise 9876543210@paytm ya yourname@okhdfcbank):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID...' }
    }
  );
});

// ================= SWIGGY IN-BOT OTP LOGIN =================

bot.hears('◈ Login Swiggy Account', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await handlePromptLogin(ctx);
});

bot.action('boss_prompt_login', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await handlePromptLogin(ctx);
});

async function handlePromptLogin(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('Login with Number', 'boss_login_with_number')
    ],
    [
      Markup.button.callback('Connected Accounts', 'boss_view_accounts'),
      Markup.button.callback('Export Session JSON', 'boss_export_picker')
    ],
    [
      Markup.button.callback('Main Menu', 'boss_panel_home'),
      Markup.button.callback('Close', 'close_menu')
    ]
  ]);

  const text = `<b>Swiggy Account Access & Login Manager:</b>\n\n` +
    `• <b>Login with JSON:</b> Session / Cookie JSON paste karein\n` +
    `• <b>Login with Number:</b> Mobile number se instant OTP aayega`;

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      return;
    } catch (e) {}
  }
  await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

// Helper to prompt for phone number with Auto-Keyboard Popup
async function promptBossLoginWithNumber(ctx) {
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_phone_for_number_login' };

  await ctx.reply(
    `<b>Login with Number</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Main Menu', callback_data: 'boss_panel_home' },
            { text: 'Close', callback_data: 'close_menu' }
          ]
        ]
      }
    }
  );

  await ctx.reply('› Enter 10-digit Mobile Number:', {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: '10 digits, or 91 + 10 digits...'
    }
  });
}

// 1. Login with JSON Prompt
bot.action('boss_login_with_json', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `<b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

// 2. Login with Number Prompt
bot.action('boss_login_with_number', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await promptBossLoginWithNumber(ctx);
});

// 2.1 Direct Send to Another Number
bot.action('send_to_another_number', async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  await ctx.answerCbQuery().catch(() => {});
  await promptBossLoginWithNumber(ctx);
});

// 2.2 Cancel OTP Login Action -> Closes prompt cleanly and restores reply keyboard
bot.action(['cancel_otp_login', 'close_menu', 'action_close', 'cancel_menu'], async (ctx) => {
  const userId = ctx.from.id;
  const prevState = userWaitState[userId];
  delete userWaitState[userId];
  if (prevState?.targetAcc) {
    deactivateSwiggyAccountViaBridge(userId, prevState.targetAcc, false).catch(() => {});
    // If Boss created an empty unlogged placeholder slot and cancelled before entering a phone/session, clean it up so the name stays reusable!
    if (prevState.createdFreshSlot) {
      const acc = getDb().config?.accounts?.[prevState.targetAcc];
      if (acc && !isAccountLoggedInSession(acc) && !acc.phone) {
        deleteAccount(prevState.targetAcc, { purgeVault: false });
      }
    }
  }
  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.deleteMessage();
  } catch (e) {
    try {
      await ctx.editMessageText('Closed.');
    } catch (e2) {}
  }
  if (isBoss(userId)) {
    await ctx.reply('Closed.', getBossReplyKeyboard());
  } else {
    await ctx.reply('Closed.', getUserReplyKeyboard());
  }
});

// 2.3 Resend OTP Action
bot.action(/^resend_otp_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = ctx.match[1];
  await ctx.answerCbQuery(`Resending OTP to ${phone}...`).catch(() => {});
  const db = getDb();
  const previousState = userWaitState[userId];
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === phone);
  const existingKey = existing ? existing[0] : (previousState?.targetAcc || `acc_${phone}`);
  const existingName = existing?.[1]?.name || previousState?.name || null;

  const result = await requestSwiggyOtpViaBridge(userId, phone, existingKey, existingName);
  if (result.success) {
    userWaitState[userId] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc: existingKey,
      phone,
      name: existingName,
      isNewUser: Boolean(result.isNewUser || previousState?.isNewUser)
    };
    await ctx.reply(
      otpSentCard(phone, [`› <i>6-digit OTP yahan type karein:</i>`]),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Copy Number', copy_text: { text: phone } }
            ],
            [
              { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}` },
              { text: 'Resend OTP', callback_data: `resend_otp_${phone}` }
            ],
            [
              { text: 'Another Number', callback_data: 'send_to_another_number' },
              { text: 'Main Menu', callback_data: 'boss_panel_home' }
            ],
            [
              { text: 'Close', callback_data: 'close_menu' }
            ]
          ]
        }
      }
    );
    await ctx.reply('› Enter OTP:', {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter 6-digit OTP...'
      }
    });
  } else {
    const errCard = formatOtpSendErrorCard(phone, result);
    await ctx.reply(errCard.text, {
      parse_mode: 'HTML',
      ...errCard.keyboard
    });
  }
});

// 2.4 Re-enter OTP Action
bot.action(/^prompt_reenter_otp_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const phone = ctx.match[1];
  await ctx.answerCbQuery('Ready for OTP...').catch(() => {});

  const db = getDb();
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === phone);
  const existingKey = existing ? existing[0] : `acc_${phone}`;
  const existingName = existing ? (existing[1]?.name || existing[0]) : null;

  const prevOrderId = userWaitState[userId]?.orderId || null;
  const prevIsNewUser = Boolean(userWaitState[userId]?.isNewUser);

  userWaitState[userId] = {
    action: 'waiting_swiggy_otp_bridge',
    targetAcc: existingKey,
    phone,
    name: existingName,
    orderId: prevOrderId,
    isNewUser: prevIsNewUser
  };

  await ctx.reply(
    `↻ <b>Re-enter OTP for <code>${phone}</code>:</b>\n\n` +
    `› Kripya sahi 6-digit OTP type karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Enter 6-digit OTP...'
      }
    }
  );
});

// Sequentially verifies and logs in a single Swiggy account from file or pasted JSON,
// checking live session, fetching profile, counting exact past orders, claiming ₹50 offers,
// and posting the rich Telegram card (behaving 100% identically to login by phone number)!
async function processAccountEntrySequentially(ctx, entry, { index = 1, total = 1, fileName = '', targetKeyOverride = null, orderIdOverride = null } = {}) {
  const norm = normalizeSwiggySessionPayload(entry);
  const filePhoneHint = (fileName && typeof fileName === 'string' ? (fileName.match(/(?:^|\D)([6-9]\d{9})(?:\D|$)/) || [])[1] : '') || '';
  const hintPhone = norm?.phone || norm?.mobile || filePhoneHint || '';

  if (!norm || (!norm.cookies && !norm.tid && !norm.token)) {
    await ctx.reply(`! <b>[${index}/${total}] ${escapeHtml(fileName || 'Session')}</b>: Valid Swiggy cookies, tid ya token nahi mila.`, { parse_mode: 'HTML' });
    return { success: false, reason: 'INVALID_CREDENTIALS' };
  }

  const label = hintPhone ? `<code>${hintPhone}</code>` : escapeHtml(norm.name || fileName || `Account #${index}`);
  const statusMsg = await ctx.reply(`◷ <i>[${index}/${total}] ${label} live verify ho raha hai...</i>`, { parse_mode: 'HTML' }).catch(() => null);

  const dbCheck = getDb();
  const vaultFallback = (hintPhone && dbCheck.sessionVault?.[hintPhone]) || (targetKeyOverride && dbCheck.sessionVault?.[targetKeyOverride]) || null;
  let rawCookieStr = norm.cookies || '';
  if ((!rawCookieStr || !rawCookieStr.includes('_session_tid=')) && vaultFallback?.cookies?.includes('_session_tid=')) {
    rawCookieStr = `${vaultFallback.cookies}; ${rawCookieStr}`;
  }
  const cookieStr = cleanEssentialSwiggyCookies(rawCookieStr, norm);

  const liveCheck = await verifySwiggySessionLive({
    ...norm,
    cookies: cookieStr,
    phone: hintPhone || norm.phone
  }).catch(err => ({ valid: false, error: err.message }));

  if (!liveCheck?.valid) {
    if (statusMsg) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    }
    await ctx.reply(
      `<blockquote>× <b>SWIGGY SESSION EXPIRED</b></blockquote>\n\n` +
      `☎ <b>Account:</b> ${label}\n` +
      `◈ <b>Status:</b> ${escapeHtml(liveCheck?.androidMessage || liveCheck?.webMessage || liveCheck?.error || 'Session expired on Swiggy')}\n\n` +
      `› <i>Kripya Mobile Number + OTP se fresh login karein ya active Swiggy JSON bhejein.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            ...(hintPhone.length === 10
              ? [Markup.button.callback(`◈ Login ${hintPhone} via OTP`, `relogin_phone_${hintPhone}`)]
              : [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')]),
            Markup.button.callback('▤ Login with JSON', 'boss_login_with_json')
          ],
          [Markup.button.callback('⌂ Main Menu', 'boss_panel_home')]
        ])
      }
    );
    return { success: false, expired: true, phone: hintPhone };
  }

  const liveTid = liveCheck.liveTid || norm.tid || '';
  const liveToken = liveCheck.token || norm.token || '';
  const liveCustomerId = liveCheck.customerId || norm.customerId || '';
  const finalCookieStr = liveCheck.cookies || cookieStr;

  const profile = (liveCheck.name && liveCheck.phone)
    ? { id: liveCustomerId, name: liveCheck.name, phone: liveCheck.phone }
    : await fetchSwiggyProfileFromCookies({ ...norm, tid: liveTid, token: liveToken, customerId: liveCustomerId, cookies: finalCookieStr }).catch(() => ({ name: null, phone: null }));

  const cleanPhone = (profile?.phone || hintPhone ? String(profile?.phone || hintPhone).replace(/[^0-9]/g, '').slice(-10) : '');
  const swiggyName = profile?.name || norm?.swiggyName || norm?.name || (cleanPhone ? `User ${cleanPhone}` : 'Swiggy User');
  const accKey = targetKeyOverride || (cleanPhone ? `acc_${cleanPhone}` : (norm?.account || 'acc_' + Date.now()));

  const result = importSessionJson({
    ...norm,
    tid: liveTid,
    token: liveToken,
    customerId: liveCustomerId || profile?.id || norm?.customerId || '',
    name: swiggyName,
    swiggyName,
    phone: cleanPhone,
    cookies: finalCookieStr
  }, accKey);

  if (statusMsg) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
  }

  if (!result.success) {
    await ctx.reply(`× <b>Import Failed for ${label}:</b> ${escapeHtml(result.message || '')}`, { parse_mode: 'HTML' });
    return { success: false, reason: result.message };
  }

  const savedKey = result.account || result.key || accKey;

  // CHAAR offer (Morning / Night / Extra ₹50 / Weekend) — ek hi engine, honest
  // read-back. Pehle yahan purana 2-offer `quickLockOnly` path chalta tha jo
  // HTTP 200 ko ✓ maan leta tha (isi liye "offer claimed" dikhta tha par ₹50
  // lagta nahi tha).
  let offersResult = null;
  try {
    offersResult = await Promise.race([
      autoActivateEventOffers({
        id: savedKey,
        phone: cleanPhone,
        token: liveToken || liveTid,
        tid: liveTid,
        cookies: finalCookieStr
      }, { force: false, offerValue: 1 }),
      new Promise(resolve => setTimeout(() => resolve(null), 12000))
    ]);
  } catch {}

  const db = getDb();
  if (db.config.accounts?.[savedKey]) {
    if (offersResult) db.config.accounts[savedKey].offers = offersResult;
    saveDb(db);
  }
  syncCloudVaultNow(db).catch(() => {});

  // Send the rich account card with live order history & order count!
  await sendAccountLoginAndOffersCard(ctx, {
    accountKey: savedKey,
    targetAcc: savedKey,
    name: db.config.accounts?.[savedKey]?.name || swiggyName,
    swiggyName,
    phone: cleanPhone,
    customerId: liveCustomerId || profile?.id || result.customerId || 'Verified',
    exportJson: exportSessionJson(savedKey),
    offers: offersResult
  }, ctx.from.id, orderIdOverride);

  return { success: true, key: savedKey, phone: cleanPhone, name: swiggyName };
}

// Process JSON / Cookie login (single account, Cookie-Editor array, OR multi-account batch!),
// verifying live against BOTH Swiggy Web DAPI and Swiggy Native Android engine one by one!
async function handleProcessJsonLogin(ctx, rawJson, userId, targetKeyOverride = null, orderIdOverride = null) {
  const prevState = userWaitState[userId] || {};
  const finalTargetKey = targetKeyOverride || prevState.targetAcc || null;
  const finalOrderId = orderIdOverride || prevState.orderId || null;
  delete userWaitState[userId];

  const extractedList = extractSwiggyAccountsListFromInput(rawJson);
  if (!extractedList.length) {
    return ctx.reply('! Invalid JSON format. Kripya valid Swiggy Session JSON, Cookie string, ya .json/.txt file bhejein.');
  }

  let successCount = 0;
  let expiredCount = 0;

  for (let i = 0; i < extractedList.length; i++) {
    const entry = extractedList[i];
    const res = await processAccountEntrySequentially(ctx, entry, {
      index: i + 1,
      total: extractedList.length,
      fileName: `account_${i + 1}.json`,
      targetKeyOverride: extractedList.length === 1 ? finalTargetKey : null,
      orderIdOverride: extractedList.length === 1 ? finalOrderId : null
    });
    if (res.success) successCount++;
    else if (res.expired) expiredCount++;
    if (i < extractedList.length - 1) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  if (extractedList.length > 1) {
    await ctx.reply(
      `<blockquote>✓ <b>ALL ACCOUNTS PROCESSED ONE BY ONE</b></blockquote>\n\n` +
      `Total Accounts: <b>${extractedList.length}</b>\n` +
      `● Logged In & Ready: <b>${successCount}</b>\n` +
      (expiredCount > 0 ? `× Expired: <b>${expiredCount}</b>\n\n` : '\n') +
      `Sabhi accounts ke order counts & ₹50 offers live lock ho chuke hain.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('◉ View Connected Accounts', 'boss_view_accounts')],
          [Markup.button.callback('⌂ Main Menu', 'boss_panel_home')]
        ])
      }
    );
  }
}

// Sends the instant claiming confirmation & detailed offers card with 1-Click FULL Code Copy
async function sendAccountLoginAndOffersCard(ctx, accInfo, userId, orderId) {
  const targetAcc = accInfo.accountKey || accInfo.targetAcc || `acc_${accInfo.phone}`;
  const displayName = accInfo.name || targetAcc;
  const swiggyName = accInfo.swiggyName || '';
  const botTag = accInfo.botTag || '';
  const phone = accInfo.phone || accInfo.mobile || '';
  const customerId = accInfo.customerId || 'Verified';

  const db = getDb();
  const activeAccNow = db.config.accounts?.[db.config.activeOrderAccount];
  // Suspended ID ko kabhi "active for orders" mat banao — order wahin atkega.
  if (!activeAccNow?.isLoggedIn || isAccountSuspended(activeAccNow)) {
    if (!isAccountSuspended(db.config.accounts?.[targetAcc])) {
      db.config.activeOrderAccount = targetAcc;
      saveDb(db);
    }
  }
  let linkedOrderId = orderId;
  if (!linkedOrderId) {
    const draft = db.drafts?.[userId];
    if (draft?.activeOrderId && db.orders?.[draft.activeOrderId]) {
      linkedOrderId = draft.activeOrderId;
    } else if (draft?.currentOrderId && db.orders?.[draft.currentOrderId]) {
      linkedOrderId = draft.currentOrderId;
    } else {
      const userOrders = Object.values(db.orders || {})
        .filter(o => o && String(o.userId) === String(userId) && !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      if (userOrders[0]) linkedOrderId = userOrders[0].id;
    }
  }

  if (linkedOrderId && db.orders[linkedOrderId]) {
    const order = db.orders[linkedOrderId];
    order.selectedAccount = targetAcc;
    order.orderAccount = phone || targetAcc;
    saveDb(db);
    updateOrderCards(order).catch(() => {});
  }

  // Live order history inspection on upload / login: determine exact past orders placed!
  const currentAcc = db.config?.accounts?.[targetAcc] || accInfo;
  let orderHistory = null;
  try {
    orderHistory = await inspectAccountOrderHistoryAndOffers(targetAcc, currentAcc, { force: true });
    if (orderHistory && orderHistory.valid !== false && orderHistory.ordersVerifiedLive === true && typeof orderHistory.totalOrdersCount === 'number') {
      // LIVE answer from Swiggy — this is the only count we are allowed to trust.
      db.config.accounts[targetAcc].totalOrdersCount = orderHistory.totalOrdersCount;
      db.config.accounts[targetAcc].cachedTotalOrdersCount = orderHistory.totalOrdersCount;
      db.config.accounts[targetAcc].ordersVerifiedLive = true;
      db.config.accounts[targetAcc].orderCountSource = 'LIVE';
      db.config.accounts[targetAcc].orderTruthCheckedAt = new Date().toISOString();
      db.config.accounts[targetAcc].isZeroOrderAccount = (orderHistory.totalOrdersCount === 0);
      delete db.config.accounts[targetAcc].accountError;
      saveDb(db);
    } else if (db.config?.accounts?.[targetAcc]) {
      // No live answer -> do NOT print any count taken from the file.
      db.config.accounts[targetAcc].ordersVerifiedLive = false;
      db.config.accounts[targetAcc].orderCountSource = 'UNVERIFIED';
      delete db.config.accounts[targetAcc].totalOrdersCount;
      delete db.config.accounts[targetAcc].isZeroOrderAccount;
      if (orderHistory?.valid === false) {
        db.config.accounts[targetAcc].accountError = orderHistory.error || 'Verification issue';
      }
      saveDb(db);
    }
  } catch (e) {}

  // HAR ID PAR CHAARON offer activate hote hain (Morning / Night / Extra ₹50 /
  // Weekend), har ek par option #1 = "₹50 off on ₹199". Ek hi engine, shared
  // ledger — dobara claim nahi hota (force nahi, warna 6h ledger bypass hota).
  if (db.config?.accounts?.[targetAcc]) {
    const accTarget = db.config.accounts[targetAcc];
    try {
      const claimOut = await autoActivateEventOffers(accTarget, { force: false, offerValue: 1 });
      if (claimOut) {
        const slots = claimOut.offers || claimOut;
        accTarget.offers = slots;
        accTarget.preferredOfferValue = 1;
        accTarget.hasBreakfast = Boolean(slots.breakfast?.status === 'CLAIMED' || slots.breakfast?.verified);
        accTarget.hasLateNight = Boolean(slots.lateNight?.status === 'CLAIMED' || slots.lateNight?.verified);
        accTarget.hasExtra50 = Boolean(slots.extra50?.status === 'CLAIMED' || slots.extra50?.verified);
        accTarget.hasWeekend = Boolean(slots.weekend?.status === 'CLAIMED' || slots.weekend?.verified);
        accTarget.hasKarwaChauth = Boolean(slots.karwaChauth?.status === 'CLAIMED' || slots.karwaChauth?.verified);
        accTarget.offerAutoActivation = {
          offerValue: 1,
          label: '₹50 off on ₹199',
          at: claimOut.at || new Date().toISOString(),
          source: 'JSON_IMPORT',
          bothClaimed: Boolean(claimOut.bothClaimed),
          allFourClaimed: Boolean(claimOut.allFourClaimed),
          claimedCount: Number(claimOut.claimedCount || 0),
          breakfast: slots.breakfast || null,
          lateNight: slots.lateNight || null,
          extra50: slots.extra50 || null,
          weekend: slots.weekend || null,
          karwaChauth: slots.karwaChauth || null
        };
        if (!accInfo.offers) accInfo.offers = {};
        accInfo.offers.lateNight = slots.lateNight;
        accInfo.offers.breakfast = slots.breakfast;
        accInfo.offers.extra50 = slots.extra50;
        accInfo.offers.weekend = slots.weekend;
        accInfo.offers.karwaChauth = slots.karwaChauth;
        saveDb(db);
      }
    } catch (e) {}
    const claimedSlot = (k) => {
      const st = String(accTarget.offers?.[k]?.status || '').toUpperCase();
      return st === 'CLAIMED' || st === 'ALREADY_CLAIMED' || accTarget.offers?.[k]?.verified === true;
    };
    let possibleCount = (accTarget.isZeroOrderAccount || accTarget.totalOrdersCount === 0) ? 1 : 0;
    possibleCount += ['breakfast', 'lateNight', 'extra50', 'weekend'].filter(claimedSlot).length;
    accTarget.possibleDiscountsCount = possibleCount;
    saveDb(db);
  }

  // Order count: ONLY a live Swiggy answer counts. No "?? 0" fallback — a file
  // that claims 0 orders must never be shown as a fresh 0-order ID.
  const liveTruth = liveOrderTruth(orderHistory?.ordersVerifiedLive === true
    ? { ...currentAcc, totalOrdersCount: orderHistory.totalOrdersCount, ordersVerifiedLive: true }
    : currentAcc);

  let pastOrdersText = '';
  let idDiagnosticNote = '';
  if (orderHistory && orderHistory.valid === false) {
    idDiagnosticNote = `\n⚠️ <b>ID Diagnostic:</b> <i>${escapeHtml(orderHistory.error || 'Session verification issue')}</i>`;
  }
  pastOrdersText = liveTruth.totalOrders === null
    ? `<i>⚠️ Live check pending — file ka likha count nahi maana jata (tap “⟳ Live Check Orders”)</i>`
    : (liveTruth.totalOrders === 0
      ? `<b>0 Orders</b> (★ LIVE verified — Max Coupons Eligible!)`
      : `<b>${liveTruth.totalOrders} Order${liveTruth.totalOrders === 1 ? '' : 's'}</b> (● Used Account — LIVE verified)`);

  const exported = exportSessionJson(targetAcc) || accInfo.exportJson || db.config?.accounts?.[targetAcc];
  const portableSource = db.config?.accounts?.[targetAcc] || exported || {};
  const sessionJsonStr = portableSessionJsonText(portableSource, targetAcc, { pretty: true });
  const compactStr = portableSessionJsonText(portableSource, targetAcc, { pretty: false });

  const offers = accInfo.offers || {};
  const lateNight = offers.lateNight || { status: 'NONE', message: 'abhi claim nahi hua' };
  const breakfast = offers.breakfast || { status: 'NONE', message: 'abhi claim nahi hua' };
  const isLateNightClaimed = lateNight.status === 'CLAIMED';
  const isBreakfastClaimed = breakfast.status === 'CLAIMED';
  const bothClaimed = isLateNightClaimed && isBreakfastClaimed;

  const lateNightStatusText = isLateNightClaimed
    ? `✓ <code>CLAIMED</code> (50 off on 199)${lateNight.message ? ` — <i>${escapeHtml(lateNight.message)}</i>` : ''}`
    : `× <code>CLAIM FAILED</code>${lateNight.message ? ` (<i>${escapeHtml(lateNight.message)}</i>)` : ''}`;
  const breakfastStatusText = isBreakfastClaimed
    ? `✓ <code>CLAIMED</code> (50 off on 199)${breakfast.message ? ` — <i>${escapeHtml(breakfast.message)}</i>` : ''}`
    : `× <code>CLAIM FAILED</code>${breakfast.message ? ` (<i>${escapeHtml(breakfast.message)}</i>)` : ''}`;

  const headerTag = bothClaimed
    ? `<blockquote>! <b>SWIGGY CLAIMING SUCCESS</b></blockquote>`
    : `<blockquote>! <b>LOGIN COMPLETE — CLAIM PARTIAL</b></blockquote>`;

  const headerBody =
    `${headerTag}\n\n` +
    `☎ <b>Account Number:</b> <code>${phone}</code>\n` +
    (swiggyName ? `◉ <b>Swiggy Profile Name:</b> <b>${escapeHtml(swiggyName)}</b>\n` : '') +
    (botTag ? `# <b>Bot Tag / Slot:</b> <code>${escapeHtml(botTag)}</code>\n` : '') +
    (!swiggyName && !botTag ? `◉ <b>Account Name:</b> <b>${escapeHtml(displayName)}</b>\n` : '') +
    `# <b>Customer ID:</b> <code>${customerId}</code>\n` +
    `📦 <b>Past Orders Count:</b> ${pastOrdersText}${idDiagnosticNote}\n\n` +
    `▣ <b>OFFERS STATUS:</b>\n` +
    `• ◷ <b>Swiggy Late Night:</b> ${lateNightStatusText}\n` +
    `• • <b>Swiggy Breakfast:</b> ${breakfastStatusText}\n\n` +
    `🎁 <b>SAARE ${OFFER_TRACKS.length} OFFER — har ek ₹50 (option 1):</b>\n` +
    `${fourOfferStatusLines(portableSource, { escape: (v) => escapeHtml(String(v ?? '')) }).join('\n')}\n` +
    `${fourOfferScoreLine(portableSource)}\n\n` +
    (bothClaimed
      ? `● <b>Status:</b> Both offers active! 50 off on 199 available on food orders.\n\n`
      : `! <b>Status:</b> One or more offers could not be claimed. Retry claim below or manage account.\n\n`) +
    (orderId ? `⌖ <b>Order #${orderId} is linked to ${escapeHtml(displayName)}!</b>\n\n` : '');

  // Keep total message safely inside Telegram's 4096-char HTML message limit (zero truncation!)
  const codeToEmbed = (headerBody.length + sessionJsonStr.length + 140 <= 4050) ? sessionJsonStr : compactStr;
  const cardText =
    headerBody +
    (codeToEmbed ? `▤ <b>Full Session Code (${codeToEmbed.length} chars):</b>\n<pre><code class="language-json">${escapeHtml(codeToEmbed)}</code></pre>\n\n` : '') +
    `▣ <i>Account is saved in DB — tap <b>Copy Code</b> below to copy 100% FULL code!</i>`;

  const keyboardButtons = [];

  keyboardButtons.push([
    { text: '▣ Claim ₹50 Offers', callback_data: `boss_retry_claim_${targetAcc}`, style: 'success' },
    { text: '₹ Claim Free Cash', callback_data: `boss_check_fc_${targetAcc}`, style: 'success' }
  ]);
  keyboardButtons.push([
    { text: '🎁 Night Offer Doctor', callback_data: `boss_offer_doctor_${targetAcc}`, style: 'primary' },
    { text: '🔧 Fix ₹50 ab', callback_data: `boss_offer_fix_${targetAcc}`, style: 'success' }
  ]);

  keyboardButtons.push([
    { text: 'Export JSON File', callback_data: `boss_export_single_${targetAcc}`, style: 'primary' },
    { text: 'Previous Orders', callback_data: `boss_prev_orders_${targetAcc}`, style: 'primary' }
  ]);

  keyboardButtons.push([
    { text: 'Order with this Account', callback_data: `boss_use_acc_${targetAcc}`, style: 'success' },
    { text: '↗ Logout Account', callback_data: `boss_logout_single_${targetAcc}`, style: 'danger' }
  ]);

  keyboardButtons.push([
    { text: 'Add Another Account', callback_data: 'send_to_another_number', style: 'primary' },
    { text: 'Delete Account from Swiggy', callback_data: `boss_swiggy_delete_start_${targetAcc}`, style: 'danger' }
  ]);

  // ⬇ COPY BLOCK — bottom of the card, one per account (portable 7-field JSON).
  const copyRow = [];
  if (compactStr) {
    copyRow.push(makeFullSessionCopyButton(ctx, '▤ Copy Session JSON', targetAcc, compactStr, `acc_copy_json_${targetAcc}`, 'success'));
    copyRow.push({ text: '⬇ Send .json', callback_data: `acc_send_json_${targetAcc}`, style: 'primary' });
  }
  if (phone) {
    copyRow.push({ text: '☎ Copy Number', copy_text: { text: phone }, style: 'primary' });
  }
  if (copyRow.length > 0) keyboardButtons.push(copyRow);

  keyboardButtons.push([
    { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' },
    { text: 'Close', callback_data: 'close_menu', style: 'danger' }
  ]);

  await sendSafeHtml(ctx, cardText, { reply_markup: { inline_keyboard: keyboardButtons } });
}

// Completes new Swiggy account setup with user's chosen custom name (or auto-assigned name)
async function completeNewAccountWithChosenName(ctx, userId, chosenRawName) {
  const currentState = userWaitState[userId];
  if (!currentState) return;
  const cleanRaw = String(chosenRawName || '').trim();
  const cleanName = cleanRaw && !/^user\s*\d*$/i.test(cleanRaw) ? cleanRaw : getNextAutoUserName();
  const phone = currentState.phone;
  const orderId = currentState.orderId;
  const accKey = currentState.targetAcc || currentState.savedSessionKey || `acc_${phone}`;

  delete userWaitState[userId];

  if (currentState.needsSignupCall) {
    const signupRes = await signupSwiggyViaBridge(userId, cleanName);
    if (signupRes.success) {
      syncCloudVaultNow(getDb()).catch(() => {});
      await sendAccountLoginAndOffersCard(ctx, signupRes, userId, orderId);
    } else if (['SWIGGY_SECURITY_CHALLENGE', 'SWIGGY_RATE_LIMIT'].includes(signupRes.code)) {
      const errCard = formatOtpSendErrorCard(phone, signupRes);
      await ctx.reply(errCard.text, { parse_mode: 'HTML', ...errCard.keyboard });
    } else {
      await ctx.reply(`<blockquote>${escapeHtml(signupRes.message)}</blockquote>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
    }
    return;
  }

  // Step 2 was already verified in verifySwiggyOtpViaBridge!
  const db = getDb();
  updateAccount(accKey, {
    name: cleanName,
    swiggyName: cleanName,
    botTag: cleanName
  });

  if (db.sessionVault) {
    if (db.sessionVault[phone]) {
      db.sessionVault[phone].name = cleanName;
      db.sessionVault[phone].swiggyName = cleanName;
      db.sessionVault[phone].botTag = cleanName;
    }
    if (db.sessionVault[accKey]) {
      db.sessionVault[accKey].name = cleanName;
      db.sessionVault[accKey].swiggyName = cleanName;
      db.sessionVault[accKey].botTag = cleanName;
    }
  }
  saveDb(db);
  syncCloudVaultNow(db).catch(() => {});

  const baseResult = currentState.verifyResult || {
    success: true,
    accountKey: accKey,
    phone,
    totalOrdersCount: 0,
    isZeroOrderAccount: true,
    customerId: db.config.accounts?.[accKey]?.customerId || 'Verified'
  };

  const finalResult = {
    ...baseResult,
    name: cleanName,
    swiggyName: cleanName,
    botTag: cleanName
  };
  if (finalResult.exportJson) {
    finalResult.exportJson.name = cleanName;
    finalResult.exportJson.swiggyName = cleanName;
    finalResult.exportJson.botTag = cleanName;
  }

  await sendAccountLoginAndOffersCard(ctx, finalResult, userId, orderId);
}

// Quick Auto-Assign or Keep Name for New Swiggy Accounts
bot.action(/^auto_assign_new_name_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];
  if (!state || (state.action !== 'waiting_swiggy_new_account_name' && state.action !== 'waiting_name_for_new_swiggy_signup')) {
    return ctx.answerCbQuery('Session expired or already processed.').catch(() => {});
  }
  await ctx.answerCbQuery('Auto-assigning name...').catch(() => {});
  await completeNewAccountWithChosenName(ctx, userId, getNextAutoUserName());
});

bot.action(/^keep_new_acc_name_(\d{10})$/, async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];
  if (!state || (state.action !== 'waiting_swiggy_new_account_name' && state.action !== 'waiting_name_for_new_swiggy_signup')) {
    return ctx.answerCbQuery('Session expired or already processed.').catch(() => {});
  }
  await ctx.answerCbQuery('Keeping name...').catch(() => {});
  await completeNewAccountWithChosenName(ctx, userId, state.existingName || getNextAutoUserName());
});

// Action: Previous orders from login card or account card
bot.action(/^boss_prev_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Fetching previous orders from Swiggy... ◷').catch(() => {});
  const key = ctx.match[1];
  await handlePreviousOrders(ctx, key);
});

// Action: Boss Main Menu / Boss Panel Home & Refresh
bot.action(['boss_panel_home', 'boss_refresh'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const home = getBossPanelHome();
  try {
    await ctx.editMessageText(home.text, { parse_mode: 'HTML', ...home.keyboard });
  } catch (e) {
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
  }
});

// ---------------------------------------------------------------------------
// BOSS DASHBOARD — order id + live tracking + the phone that placed it
// ---------------------------------------------------------------------------
async function renderBossDashboard(ctx, { onlyMissingTracking = false, limit = 8 } = {}) {
  const view = buildBossDashboard(getDb(), { limit, onlyMissingTracking });
  try {
    await ctx.editMessageText(view.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...view.keyboard });
  } catch {
    await ctx.reply(view.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...view.keyboard });
  }
  return view;
}

bot.action('boss_dashboard', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Dashboard refreshed').catch(() => {});
  await renderBossDashboard(ctx);
});

bot.command(['dashboard', 'tracking_dashboard'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  const view = buildBossDashboard(getDb(), { limit: 10 });
  await ctx.reply(view.text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...view.keyboard });
});

bot.action(/^boss_track_now_([A-Za-z0-9_-]+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Scanning Swiggy IDs for the live share link…').catch(() => {});

  const result = await ensureOrderTracking(orderId, { force: true, budgetMs: 22000, deep: true });
  const fresh = getDb().orders?.[orderId] || order;
  const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
  const swiggyId = swiggyOrderIdOf(fresh);
  const phone = placedFromPhoneOf(fresh, getDb());

  let text;
  const rawLiveStatusStr = String(fresh.liveOrderStatus || result?.orderStatus || '');
  const liveStatusStr = normalizeSwiggyLiveOrderStatus(rawLiveStatusStr) || rawLiveStatusStr;
  const isCancelledStatus = /cancel|refus|return/i.test(liveStatusStr);
  const isDeliveredStatus = !isCancelledStatus && /deliv/i.test(liveStatusStr);
  const deliveredTrackUrl = !trackingUrl && isDeliveredStatus ? buildSignedOrderTrackUrl(swiggyId || fresh.id) : '';
  if (trackingUrl) {
    text = `✅ <b>Tracking found</b>\n` +
      `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
      `▪ <b>Order ref:</b> <code>#${escapeHtml(String(fresh.id))}</code>\n` +
      `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
      (liveStatusStr ? `▪ <b>Status:</b> <code>${escapeHtml(liveStatusStr)}</code>\n` : '') +
      `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open live Swiggy tracking</a>` +
      (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '');
  } else if (result?.status === 'NO_SWIGGY_ID') {
    text = `⏳ <b>Swiggy order id abhi create nahi hua.</b>\nPayment confirm hote hi bot khud tracking laayega — kuch karne ki zaroorat nahi.`;
  } else if (result?.status === 'ORDER_FOUND' && isCancelledStatus) {
    text = `✅ <b>Order Swiggy par mil gaya</b> (<code>${escapeHtml(swiggyId || '')}</code> on <code>${escapeHtml(phone || '—')}</code>) — status <code>${escapeHtml(liveStatusStr)}</code>.\n\n<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`;
  } else if (result?.status === 'ORDER_FOUND' && isDeliveredStatus) {
    text = `✅ <b>Tracking link ready</b>\n` +
      `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
      `▪ <b>Order ref:</b> <code>#${escapeHtml(String(fresh.id))}</code>\n` +
      `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
      `▪ <b>Status:</b> <code>${escapeHtml(liveStatusStr)}</code>\n` +
      (deliveredTrackUrl ? `▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredTrackUrl)}">Open order tracking</a>` : '') +
      (fresh.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(fresh.deliveryOtp))}</code>` : '') +
      (fresh.deliveryBoyName || fresh.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([fresh.deliveryBoyName, fresh.deliveryBoyMobile].filter(Boolean).join(' · '))}` : '');
  } else if (result?.status === 'ORDER_FOUND') {
    text = `✅ <b>Order Swiggy par mil gaya</b> (<code>${escapeHtml(swiggyId || '')}</code> on <code>${escapeHtml(phone || '—')}</code>) — lekin Swiggy ne share link abhi publish nahi kiya.\n\n<i>Bot har 10s–30s me retry karta rahega aur link aate hi bhej dega.</i>`;
  } else if (result?.status === 'TIMEOUT') {
    text = `◷ <b>Scan time out ho gaya</b> (${Number(result.scanned) || 0} IDs checked).\nSwiggy slow hai — dobara try karein. Koi fake link nahi banaya jayega.`;
  } else {
    text = `❌ <b>Swiggy order <code>${escapeHtml(swiggyId || '')}</code> kisi bhi ID par nahi mila.</b>\n\nCheck karein ki order ID sahi hai (numeric, 12–18 digits). Bot koi false tracking link nahi banata.`;
  }

  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(trackingUrl
      ? Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy tracking', trackingUrl)]])
      : (!isCancelledStatus && result?.status === 'ORDER_FOUND'
        ? Markup.inlineKeyboard([
            ...(deliveredTrackUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredTrackUrl)]] : []),
            [Markup.button.callback('🔄 Re-check Tracking', `boss_track_now_${fresh.id}`)]
          ])
        : {}))
  }).catch(() => {});

  if (!trackingUrl && !isTerminalDeliveryStatus(liveStatusStr) && ['ORDER_FOUND', 'TIMEOUT'].includes(result?.status)) {
    startOrderTrackingAuto(fresh.id, { force: true, budgetMs: 12000 });
  }
  if (ctx.callbackQuery?.message?.message_id) {
    await renderBossDashboard(ctx, { limit: 8 });
  }
});

bot.action('boss_fetch_all_missing', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Fetching tracking for orders that need it…').catch(() => {});

  const db = getDb();
  const pending = Object.values(db.orders || {})
    .filter(o => o && o.id && ['COMPLETED', 'ACCEPTED'].includes(o.status) && !getStoredSwiggyTrackingUrl(o) && swiggyOrderIdOf(o))
    .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0))
    // Small batch: 4 orders × 10s keeps this button well inside the handler timeout.
    .slice(0, 4);

  if (pending.length === 0) {
    const confirmed = Object.values(db.orders || {})
      .filter(o => o && o.id && ['COMPLETED', 'ACCEPTED'].includes(String(o.status || '')) && swiggyOrderIdOf(o));
    const msg = confirmed.length === 0
      ? 'ℹ️ <b>Abhi koi confirmed Swiggy order nahi hai.</b>\n<i>Tracking fetch karne ke liye pehle order place/confirm hona chahiye.</i>'
      : `✅ <b>Sab ${confirmed.length} confirmed/delivered orders ke tracking link already available hain.</b>`;
    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }

  let found = 0;
  const failed = [];
  for (const order of pending) {
    const res = await ensureOrderTracking(order, { force: true, budgetMs: 12000, deep: true }).catch(() => null);
    if (res?.trackingUrl) {
      found += 1;
      try { await tryEditCustomerPaymentMessageWithTracking(getDb().orders?.[order.id] || order); } catch {}
    } else {
      failed.push(String(swiggyOrderIdOf(order) || order.id));
      startOrderTrackingAuto(order.id, { force: true, budgetMs: 12000 });
    }
  }

  await ctx.reply(
    `🔎 <b>Tracking scan complete</b>\n` +
    `▪ Found: <b>${found}</b>\n` +
    `▪ Still waiting on Swiggy: <b>${failed.length}</b>` +
    (failed.length ? `\n<code>${escapeHtml(failed.join(', '))}</code>\n\n<i>Bot background me retry karta rahega.</i>` : ''),
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await renderBossDashboard(ctx, { limit: 8 });
});

bot.command(['menu', 'panel'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return;
  await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  await ctx.reply('Boss Panel:', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Main Menu', 'Menu', 'Boss Panel', '★ Boss Panel', '★ Menu', '⌂ Main Menu', '⌂ Boss Panel'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (!isBoss(ctx.from.id)) return;
  await ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  await ctx.reply('Boss Panel:', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
});

bot.hears(['Close', 'close', '× Close'], async (ctx) => {
  delete userWaitState[ctx.from.id];
  if (isBoss(ctx.from.id)) {
    await ctx.reply('Closed.', getBossReplyKeyboard());
  } else {
    await ctx.reply('Closed.', getUserReplyKeyboard());
  }
});

// Action: Use account for orders
bot.action(/^boss_use_acc_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  const db = getDb();
  if (db.config.accounts?.[accKey]) {
    // ⛔ Suspended ID par order place hi nahi hoga — select karne ka matlab hoga
    // order ko dobara atka dena. Honest refusal + turant retry ka option.
    if (isAccountSuspended(db.config.accounts[accKey])) {
      const suspendInfo = describeSuspendedAccount(db.config.accounts[accKey]);
      return ctx.answerCbQuery(
        `⛔ Ye ID suspended hai — ${suspendInfo}. "Retry" se quarantine hatayein.`,
        { show_alert: true }
      ).catch(() => {});
    }
    db.config.activeOrderAccount = accKey;
    const phone = db.config.accounts[accKey].phone || db.config.accounts[accKey].mobile || accKey;
    const draft = db.drafts?.[ctx.from.id];
    const pendingOrderId = draft?.activeOrderId || draft?.currentOrderId;
    if (pendingOrderId && db.orders?.[pendingOrderId]) {
      const ord = db.orders[pendingOrderId];
      ord.selectedAccount = accKey;
      ord.orderAccount = phone;
      updateOrderCards(ord).catch(() => {});
    }
    saveDb(db);
    await ctx.answerCbQuery(`Selected ${db.config.accounts[accKey].name || accKey} for orders! ✓`).catch(() => {});
    await ctx.reply(`● <b>Account "${escapeHtml(db.config.accounts[accKey].name || accKey)}" is now ACTIVE for all orders!</b>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  } else {
    await ctx.answerCbQuery('Account not found!').catch(() => {});
  }
});

// Action: ⛔ Suspended ID ko retry/enable karo (quarantine clear)
bot.action(/^boss_retry_acc_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  const db = getDb();
  const acc = db.config.accounts?.[accKey];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  const wasSuspended = isAccountSuspended(acc);
  markAccountHealthy(accKey, { note: 'boss manual retry' });
  await ctx.answerCbQuery(wasSuspended ? '⛔ Quarantine hata diya — ID phir try hogi' : 'ID already healthy hai').catch(() => {});
  await ctx.reply(
    `✅ <b>${escapeHtml(acc.name || acc.phone || accKey)}</b> retry ke liye enable ho gayi.\n` +
    `<i>Ab order card par ⚡ Next fresh ID dabaiye — bill turant isi ID par banega. Agar Swiggy ne sach me block kiya hai to phir ⛔ ho jayegi (jhooth nahi bolenge).</i>`,
    { parse_mode: 'HTML', ...getBossPanelKeyboard() }
  ).catch(() => {});
});

// ============================================================================
// 🎁 OFFER DOCTOR — per-ID truth: kaunsa campaign, kaunsa reward, HTTP kya,
// aur slot abhi khula hai ya nahi. "Likh diya" kabhi success nahi kaha jata;
// sirf GET read-back (`shouldNotify` + `value`) sach hai.
// ============================================================================
async function sendOfferDoctorCard(ctx, key, { fix = false, edit = false } = {}) {
  const acc = getDb().config?.accounts?.[key];
  if (!acc) return ctx.reply('Account not found.');
  const label = `${acc.name || key} (${acc.phone || 'no phone'})`;
  let report = null;
  try {
    report = await runOfferDoctorForAccount(key, { fix });
  } catch (err) {
    report = { ok: false, verdict: [`Doctor fail: ${String(err?.message || err).slice(0, 150)}`] };
  }
  // Status pehle: saare offer, har ek ₹50 — phir live doctor detail.
  const statusBlock = fourOfferStatusBlock(acc, { escape: (v) => escapeHtml(String(v ?? '')) });
  const text = statusBlock + '\n\n' +
    formatOfferDoctorReport(report?.ok === false && report?.before ? report.before : report, {
    accountLabel: label,
    escapeHtml: (v) => escapeHtml(String(v ?? ''))
  }) + (fix && report?.changes?.length
    ? '\n\n<b>🔧 Fix result (read-back verified):</b>\n' + report.changes
      .map((c) => `${c.verified ? '✅' : '❌'} <code>${escapeHtml(c.campaign)}</code> — ${escapeHtml(c.verified ? '₹50 free cash saved' : (c.reason || 'not saved'))}`)
      .join('\n')
    : '') +
    (fix && report?.verifiedAny
      ? '\n\n<i>Ab cart me ₹199+ ka order rakhein — cash khud lagega. Cart dobara scan karne par amount update ho jayega.</i>'
      : '');

  const buttons = [
    [Markup.button.callback('🔧 Fix ₹50 ab (read-back)', `boss_offer_fix_${key}`)],
    [Markup.button.callback('⟳ Doctor dobara chalao', `boss_offer_doctor_${key}`)],
    [Markup.button.callback('▣ Claim ₹50 Offers', `boss_retry_claim_${key}`)],
    // CHAAR offer links — boss ne diye: Morning / Night / Extra ₹50 / Weekend
    [Markup.button.url('🌙 Morning Link', OFFER_LINK_URLS.lateNight)],
    [Markup.button.url('☀ Night Link', OFFER_LINK_URLS.breakfast)],
    [Markup.button.url('💸 Extra ₹50 Link', OFFER_LINK_URLS.extra50)],
    [Markup.button.url('🎉 Weekend Link', OFFER_LINK_URLS.weekend)],
    [Markup.button.callback('◉ Account card', `boss_acc_detail_${key}`)]
  ];
  if (edit) {
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() =>
      ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) })
    );
  }
  return ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard(buttons) });
}

bot.action(/^boss_offer_doctor_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  await ctx.answerCbQuery('🎁 Swiggy se asli state padh raha hoon...').catch(() => {});
  const wait = await ctx.reply('🎁 <i>Offer Doctor: har campaign ki live state (GET /api/notify) padh raha hoon…</i>', { parse_mode: 'HTML' }).catch(() => null);
  await sendOfferDoctorCard(ctx, key, { fix: false });
  if (wait?.message_id) { try { await bot.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
});

bot.action(/^boss_offer_fix_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  await ctx.answerCbQuery('🔧 ₹50 free cash book kar raha hoon…').catch(() => {});
  const wait = await ctx.reply('🔧 <i>Option 1 (₹50 free cash) likh raha hoon, phir server se read-back verify karunga…</i>', { parse_mode: 'HTML' }).catch(() => null);
  await sendOfferDoctorCard(ctx, key, { fix: true });
  if (wait?.message_id) { try { await bot.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
});

// /offers — saare IDs ka ek saath doctor (Boss: "mera ID kaam nahi kar raha")
bot.command(['offers', 'offercheck', 'nightoffer'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('Sirf Boss ke liye.');
  const db = getDb();
  const keys = Object.keys(db.config?.accounts || {}).filter((k) => {
    const a = db.config.accounts[k];
    return a && !isAccountSuspended(a);
  });
  if (keys.length === 0) return ctx.reply('Vault me koi ID nahi — pehle JSON import karein.');
  const wait = await ctx.reply(`🎁 <i>${keys.length} ID ka offer state padh raha hoon (late-night + breakfast)…</i>`, { parse_mode: 'HTML' }).catch(() => null);
  const lines = ['🎁 <b>OFFER DOCTOR — SAB ID</b>', ''];
  const buttons = [];
  for (const key of keys.slice(0, 12)) {
    const acc = db.config.accounts[key];
    const rep = await runOfferDoctorForAccount(key, {}).catch(() => null);
    const ln = rep?.tracks?.lateNight;
    const bf = rep?.tracks?.breakfast;
    const icon = (t) => (t?.state === 'LIVE_NOW' || t?.state === 'BOOKED' ? '🟢' : (t?.state === 'WRONG_REWARD' ? '🟡' : '🔴'));
    lines.push(`${icon(ln)} <code>${escapeHtml(String(acc.phone || key).replace(/^acc_/, ''))}</code> — LN: <b>${escapeHtml(ln?.state || '?')}</b> · BF: <b>${escapeHtml(bf?.state || '?')}</b>`);
    if (ln && ln.state !== 'BOOKED' && ln.state !== 'LIVE_NOW') lines.push(`   <i>${escapeHtml(String(ln.reason || '').slice(0, 110))}</i>`);
    buttons.push([Markup.button.callback(`🔧 Fix ${String(acc.phone || key).replace(/^acc_/, '')}`, `boss_offer_fix_${key}`)]);
  }
  buttons.push([Markup.button.callback('◉ Accounts', 'boss_view_accounts')]);
  const text = lines.join('\n');
  if (wait?.message_id) { try { await bot.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {} }
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...Markup.inlineKeyboard(buttons) });
});

// Action: Retry offer claims
bot.action(/^boss_retry_claim_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  await ctx.answerCbQuery('Retrying offer claims with Swiggy API... ◷').catch(() => {});
  const db = getDb();
  const acc = db.config.accounts?.[accKey];
  if (!acc) return ctx.reply('× Account not found.');

  const retryWait = await ctx.reply(`◷ <i>Saare ${OFFER_TRACKS.length} offer (Morning / Night / Extra ₹50 / Weekend / Karwa Chauth) claim kar raha hoon for <b>${escapeHtml(acc.name || accKey)}</b> — har ek par ₹50 (option 1)...</i>`, { parse_mode: 'HTML' });
  // CHAARON offers ek hi engine se — `force: false` isliye ki 6h ledger ke andar
  // dobara claim na ho (boss: "2 times claim ho rha tha").
  const claimRes = await autoActivateEventOffers(acc, {
    force: false,
    offerValue: acc.preferredOfferValue || 1
  });
  const slots = claimRes?.offers || claimRes || {};
  acc.offers = slots;
  acc.preferredOfferValue = 1;
  const slotClaimed = (k) => String(slots?.[k]?.status || '').toUpperCase() === 'CLAIMED' || slots?.[k]?.verified === true;
  acc.hasBreakfast = slotClaimed('breakfast');
  acc.hasLateNight = slotClaimed('lateNight');
  acc.hasExtra50 = slotClaimed('extra50');
  acc.hasWeekend = slotClaimed('weekend');
  acc.hasKarwaChauth = slotClaimed('karwaChauth');
  acc.offerAutoActivation = {
    offerValue: 1,
    label: '₹50 off on ₹199',
    at: claimRes?.at || new Date().toISOString(),
    source: 'MANUAL_CLAIM',
    bothClaimed: Boolean(claimRes?.bothClaimed),
    allFourClaimed: Boolean(claimRes?.allFourClaimed),
    claimedCount: Number(claimRes?.claimedCount || 0),
    breakfast: slots.breakfast || null,
    lateNight: slots.lateNight || null,
    extra50: slots.extra50 || null,
    weekend: slots.weekend || null,
    karwaChauth: slots.karwaChauth || null
  };
  saveDb(db);
  try { await bot.telegram.deleteMessage(ctx.chat.id, retryWait.message_id); } catch (e) {}

  // Chaaron ka sach turant: kaunsa laga, kaunsa pre-locked, kaunsa fail + asli wajah.
  await ctx.reply(
    `${fourOfferStatusBlock(acc, { escape: (v) => escapeHtml(String(v ?? '')) })}\n\n` +
    `<i>${claimRes?.allFourClaimed
      ? `Saare ${OFFER_TRACKS.length} offer me ₹50 lag gaya — ₹${OFFER_TRACKS.length * 50} tak free cash.`
      : 'Jo nahi laga uska asli reason upar likha hai. “🔧 Fix ₹50 ab” dabaiye — read-back ke baad hi ✓ milta hai.'}</i>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎁 Offer Doctor (live)', `boss_offer_doctor_${accKey}`)],
        [Markup.button.callback('🔧 Fix ₹50 ab (read-back)', `boss_offer_fix_${accKey}`)],
        [Markup.button.callback('◉ Account card', `boss_acc_detail_${accKey}`)]
      ])
    }
  ).catch(() => {});

  // Offer laga ya nahi — likhne ke baad READ-BACK truth. Fail hone par chup
  // mat raho: doctor chala kar asli reason (value drift / 403 / cutoff) dikhao.
  if (!(acc.hasBreakfast && acc.hasLateNight && acc.hasExtra50 && acc.hasWeekend)) {
    const doctor = await runOfferDoctorForAccount(accKey, {}).catch(() => null);
    if (doctor?.ok) {
      await ctx.reply(
        formatOfferDoctorReport(doctor, {
          accountLabel: `${acc.name || accKey} (${acc.phone || ''})`,
          escapeHtml: (v) => escapeHtml(String(v ?? ''))
        }),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔧 Fix ₹50 ab (read-back)', `boss_offer_fix_${accKey}`)],
            [Markup.button.callback('◉ Account card', `boss_acc_detail_${accKey}`)]
          ])
        }
      ).catch(() => {});
    }
  }

  await sendAccountLoginAndOffersCard(ctx, {
    accountKey: accKey,
    name: acc.name,
    phone: acc.phone,
    customerId: acc.customerId,
    offers: acc.offers,
    exportJson: acc
  }, ctx.from.id, null);
});


// ================= ACCOUNT SELECTOR IN BOSS CARD =================

// ================= ACCOUNT SELECTOR IN BOSS CARD (FIGJAM FLOW) =================

// Screen 2 -> Open Account Picker
bot.action(/^boss_choose_acc_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  const db = getDb();
  const accounts = db.config.accounts || {};
  const buttons = [];
  const accEntries = Object.entries(accounts);

  if (accEntries.length === 0) {
    buttons.push([
      Markup.button.callback('◈ Login with JSON', 'boss_login_with_json'),
      Markup.button.callback('☎ Login with Number', 'boss_login_with_number')
    ]);
  } else {
    for (let i = 0; i < accEntries.length; i += 2) {
      const row = [];
      const [k1, a1] = accEntries[i];
      const m1 = a1.isLoggedIn ? '●' : '○';
      row.push(Markup.button.callback(`${m1} ${a1.name || k1}`, `boss_choose_acc_${k1}_${orderId}`));
      if (accEntries[i + 1]) {
        const [k2, a2] = accEntries[i + 1];
        const m2 = a2.isLoggedIn ? '●' : '○';
        row.push(Markup.button.callback(`${m2} ${a2.name || k2}`, `boss_choose_acc_${k2}_${orderId}`));
      }
      buttons.push(row);
    }
    buttons.push([
      Markup.button.callback('+ Login Another Account', 'boss_prompt_login')
    ]);
  }

  await ctx.reply(
    `◉ <b>Choose Account to order for #${escapeHtml(String(orderId))}:</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

// Account Chosen for Order -> Auto-parse cart & calculate bill
bot.action(/^(?:boss_sel_acc|boss_choose_acc)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let accKey = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.endsWith('_' + oid)) {
      orderId = oid;
      accKey = payload.slice(0, -(oid.length + 1));
      break;
    } else if (payload.startsWith(oid + '_')) {
      orderId = oid;
      accKey = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const lastUnderscore = payload.lastIndexOf('_');
    if (lastUnderscore !== -1) {
      const candidateOid = payload.slice(lastUnderscore + 1);
      if (db.orders[candidateOid]) {
        orderId = candidateOid;
        accKey = payload.slice(0, lastUnderscore);
      }
    }
  }

  let order = lookupOrder(db, orderId);


  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.selectedAccount = accKey;
  order.amountAccepted = false;
  order.waitingConfirmation = false;
  saveDb(db);

  const accountData = db.config.accounts?.[accKey];
  const accName = accountData?.name || accKey;
  await ctx.answerCbQuery(`Selected: ${accName}! Calculating bill... ◷`).catch(() => {});

  // Fast verify Swiggy cart & items using account cookies or verified metadata
  try {
    const accountSession = accountData ? {
      token: accountData.token || null,
      tid: accountData.tid || null,
      sid: accountData.sid || null,
      deviceId: accountData.deviceId || null
    } : null;

    if (order.cart) {
      const swiggyData = await verifyAndInspectSwiggyLink(order.cart, accountData?.cookies, accountSession);
      if (swiggyData.verified || (swiggyData.items && swiggyData.items.length > 0)) {
        order.swiggyVerified = true;
        if (swiggyData.restaurantName) order.restaurantName = swiggyData.restaurantName;
        if (swiggyData.items && swiggyData.items.length > 0) order.items = swiggyData.items;
        if (swiggyData.subtotal > 0) order.subtotal = swiggyData.subtotal;
        if (swiggyData.itemTotal > 0) order.itemTotal = swiggyData.itemTotal;
        if (swiggyData.discountAmount > 0) order.discountAmount = swiggyData.discountAmount;
        if (swiggyData.couponCode) order.couponCode = swiggyData.couponCode;
        if (swiggyData.freeCashApplied > 0) order.freeCashApplied = swiggyData.freeCashApplied;
        if (swiggyData.swiggyOneMembershipFee > 0) order.swiggyOneMembershipFee = swiggyData.swiggyOneMembershipFee;
        if (swiggyData.packingCharges > 0) order.packingCharges = swiggyData.packingCharges;
        if (swiggyData.taxesAndCharges > 0) order.taxesAndCharges = swiggyData.taxesAndCharges;
        if (swiggyData.deliveryFee !== undefined) order.deliveryFee = swiggyData.deliveryFee;
        if (swiggyData.freeDeliveryDiscount !== undefined) order.freeDeliveryDiscount = swiggyData.freeDeliveryDiscount;
        if (swiggyData.swiggyOneApplied) order.swiggyOneApplied = true;
        if (swiggyData.finalPayable > 0) order.finalPayable = swiggyData.finalPayable;
        if (swiggyData.totalSavings > 0) order.totalSavings = swiggyData.totalSavings;
      }
    }
    if (order.address && !order.addressDetails) {
      const addrMeta = await resolveSwiggyLink(order.address);
      if (addrMeta.addressDetails) {
        order.addressDetails = addrMeta.addressDetails;
      }
    }
  } catch (err) {
    console.error('Error verifying cart for chosen account:', err.message);
  }

  saveDb(db);

  // Update in-place on single cards for Boss and User! (NO DUPLICATE MESSAGES)
  await updateOrderCards(order);
});

// Change Account Button on Order Card
bot.action(/^boss_change_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.selectedAccount = null;
  order.waitingConfirmation = false;
  order.status = 'PENDING';
  saveDb(db);

  await ctx.answerCbQuery('Choose a different account:').catch(() => {});
  await updateOrderCards(order);
});

// Send for Confirmation Button on Order Card
bot.action(/^boss_send_confirm_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.status = 'WAITING_CONFIRMATION';
  order.waitingConfirmation = true;
  order.sentForConfirmationAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('Sent for Confirmation to Customer! ›').catch(() => {});
  await updateOrderCards(order);

  // If user card message id is not set, deliver card to user
  if (order.userChatId && !order.userMessageId) {
    try {
      const userCard = customerOrderCard(order);
      const sent = await bot.telegram.sendMessage(order.userChatId, userCard.text, {
        parse_mode: 'HTML',
        ...userCard.keyboard
      });
      order.userMessageId = sent.message_id;
      saveDb(db);
    } catch (e) {}
  }
});

// Text User Button
bot.action(/^boss_text_user_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_text_user', orderId, targetUserId: order.userId };

  const userProfileUrl = `tg://user?id=${order.userId}`;
  await ctx.reply(
    `✉ <b>Send message to <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (Order #${orderId}):</b>\n\n` +
    `# <b>User TG ID:</b> <a href="${userProfileUrl}">${order.userId}</a>\n\n` +
    `<i>Chat me message likh kar bhejein ya upar TG ID par click karke direct profile kholein:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Type message for user...' }
    }
  );
});

// Dynamic Account Picker on Order Card
bot.action(/^boss_choose_acc_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  const accounts = db.config.accounts || {};

  const buttons = [];
  const accEntries = Object.entries(accounts);

  for (let i = 0; i < accEntries.length; i += 2) {
    const row = [];
    const [k1, a1] = accEntries[i];
    const s1 = a1.isLoggedIn ? '●' : '○';
    const p1 = a1.phone || a1.mobile || a1.name || k1;
    row.push(Markup.button.callback(`${s1} ${p1}`, `boss_select_acc_${orderId}_${k1}`));

    if (accEntries[i + 1]) {
      const [k2, a2] = accEntries[i + 1];
      const s2 = a2.isLoggedIn ? '●' : '○';
      const p2 = a2.phone || a2.mobile || a2.name || k2;
      row.push(Markup.button.callback(`${s2} ${p2}`, `boss_select_acc_${orderId}_${k2}`));
    }
    buttons.push(row);
  }

  buttons.push([
    Markup.button.callback('+ Add New Account', `boss_add_new_acc_for_order_${orderId}`),
    Markup.button.callback('← Back to Order', `boss_back_to_order_${orderId}`)
  ]);

  await ctx.reply(
    `◉ <b>CHOOSE SWIGGY ACCOUNT FOR ORDER #${orderId}:</b>\n\n` +
    `Select the account to place this order with. (Swiggy offers, coupons & free delivery will be applied automatically):\n\n` +
    `<i>● = Logged In | ○ = Not Logged In</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Selecting Account for Order -> Runs Group Cart Sync, Coupon Optimizer & Displays Boss Review Screen
bot.action(/^boss_select_acc_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let accKey = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.endsWith('_' + oid)) {
      orderId = oid;
      accKey = payload.slice(0, -(oid.length + 1));
      break;
    } else if (payload.startsWith(oid + '_')) {
      orderId = oid;
      accKey = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const lastUnderscore = payload.lastIndexOf('_');
    if (lastUnderscore !== -1) {
      const candidateOid = payload.slice(lastUnderscore + 1);
      if (db.orders[candidateOid]) {
        orderId = candidateOid;
        accKey = payload.slice(0, lastUnderscore);
      }
    }
  }

  if (!orderId || !db.orders[orderId]) {
    const idx = payload.indexOf('_');
    if (idx !== -1) {
      orderId = payload.slice(0, idx);
      accKey = payload.slice(idx + 1);
    }
  }

  let order = lookupOrder(db, orderId);


  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  const acc = db.config.accounts?.[accKey];
  const accPhone = acc?.phone || acc?.mobile || acc?.name || 'Selected Account';
  const accName = acc?.name || accPhone;

  order.selectedAccount = accKey;
  order.orderAccount = accPhone;
  order.paymentSentToUser = false; // NEVER directly send to customer before Boss review!
  saveDb(db);

  await ctx.answerCbQuery(`Selected ${accPhone}! Processing cart & capturing payment QR... ›`).catch(() => {});
  const waitMsg = await ctx.reply(
    `◷ <b>Processing Order #${orderId} on Swiggy Account: ${escapeHtml(accPhone)} (${escapeHtml(accName)})...</b>\n\n` +
    `1️⃣ Reading items & syncing Customer Group Cart into account\n` +
    `2️⃣ Checking saved address history & delivery location\n` +
    `3️⃣ Finding available coupons & discounts on account\n` +
    `4️⃣ Navigating to checkout & capturing authentic Swiggy Payment QR...`,
    { parse_mode: 'HTML' }
  );

  // Run full group cart sync, address binding, coupon optimization & checkout payment screen capture in background
  // to avoid Telegraf's 90,000ms callback query timeout error!
  (async () => {
    try {
      const result = await syncGroupCartAndCheckoutForAccount(acc, order);
      console.log(`[syncGroupCartAndCheckoutForAccount] Result for Order #${orderId}:`, {
        success: result.success,
        sessionExpired: Boolean(result.sessionExpired),
        hasQr: Boolean(result.qrBuffer),
        paymentUrl: result.paymentUrl,
        itemsCount: result.cartData?.items?.length || 0,
        savedAddressesCount: result.savedAddresses?.length || 0,
        availableCouponsCount: result.availableCoupons?.length || 0
      });

      if (result.sessionExpired) {
        if (acc) {
          acc.isLoggedIn = false;
          saveDb(db);
        }
        // ZERO-OTP AUTO-FAILOVER: Automatically pick the best remaining saved `.json` account from Vault instead of asking for OTP!
        const fallbackBest = await findBestMaxCouponAccountForOrder(order, {
          captureScreenshot: false,
          excludeAccountKeys: [accKey]
        }).catch(() => null);

        if (fallbackBest?.success && fallbackBest.winningKey) {
          const fbDb = getDb();
          fbDb.orders[order.id] = order;
          saveDb(fbDb);
          try {
            await sendBillSummaryToCustomerOnce(bot.telegram, order, {
              db: getDb(),
              deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary),
              onMessageSent: (sentMsg) => rememberUserCard(order.userChatId || order.userId, sentMsg)
            });
          } catch {}
          order = getDb().orders?.[order.id] || order;
          try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
          await updateOrderCards(order);
          return;
        }

        try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
        await ctx.reply(
          `! <b>No Active Session Remaining in Vault</b>\n\n` +
          `Purana account (<code>${escapeHtml(accPhone)}</code>) expire ho gaya tha aur Vault me koi aur active JSON file nahi bachi.\n` +
          `▤ <i>Bas chat me apne <code>.json</code> / <code>.zip</code> account files drop kar dein — bot bina OTP sab save karke order ready kar dega!</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return;
      }

      if (!result?.success) {
        order.selectedAccount = accKey;
        order.orderAccount = accPhone;
        order.lastAccountError = result?.error || 'Delivery/Cart sync issue';
        saveDb(db);
        try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
        await ctx.reply(
          `× <b>Order #${orderId} — Account Selected: ${escapeHtml(accPhone)}</b>\n\n` +
          `⚠️ <b>Dikkat:</b> ${escapeHtml(result?.error || 'Delivery address, location, or recipient mobile could not be verified.')}\n\n` +
          `<i>Account select ho gaya hai, par Swiggy checkout par yeh dikkat aayi. Details check karke dobara retry karein.</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        await updateOrderCards(order).catch(() => {});
        return;
      }

      if (result.cartData) {
        const cd = result.cartData;
        if (cd.restaurantName) order.restaurantName = cd.restaurantName;
        if (cd.items && cd.items.length > 0) order.items = cd.items;
        if (cd.address && (!order.address || order.address === 'Address pending / not provided')) {
          order.address = cd.address;
        }
        order.itemTotal = cd.itemTotal || order.itemTotal;
        order.subtotal = cd.subtotal || order.subtotal;
        order.swiggyOneMembershipFee = cd.swiggyOneMembershipFee || 0;
        order.deliveryFee = cd.deliveryFee || 0;
        order.freeDeliveryDiscount = cd.freeDeliveryDiscount || 0;
        order.swiggyOneApplied = cd.swiggyOneApplied || false;
        order.swiggyOneSavings = cd.swiggyOneSavings || 0;
        order.couponCode = cd.couponCode || null;
        order.discountAmount = cd.discountAmount || 0;
        order.freeCashBalance = cd.freeCashBalance || 0;
        order.freeCashApplied = cd.freeCashApplied || 0;
        order.finalPayable = cd.finalPayable || order.finalPayable;
        order.totalSavings = cd.totalSavings || order.totalSavings;
        if (cd.addressDetails) {
          order.addressDetails = cd.addressDetails;
        }
        order.packingCharges = cd.packingCharges || 0;
        order.taxesAndCharges = cd.taxesAndCharges || 0;
        order.swiggyVerified = true;
      }

      if (result.savedAddresses && result.savedAddresses.length > 0) {
        // Keep these for the explicit address picker only; never auto-select savedAddresses[0].
        order.accountAddresses = result.savedAddresses;
      }
      if (result.availableCoupons && result.availableCoupons.length > 0) {
        order.availableCoupons = result.availableCoupons;
      }

      // Always ensure max offer is calculated
      applyMaxOfferToOrder(order);

      if (result.paymentUrl) {
        order.swiggyPaymentUrl = result.paymentUrl;
      }

      // Generate authentic personalized QR Card with customer's name embedded in the center of the QR
      const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
      // Boss (30-10-2026): order QR SIRF Swiggy ka (boss ki UPI se nahi).
      const swiggyOnlyUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
      const upiUri = swiggyOnlyUri ? sanitizeUpiUriForQr(swiggyOnlyUri) : '';

      let finalQrBuffer = result.qrBuffer;
      try {
        const cardBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri,
          qrBuffer: result.qrBuffer
        });
        if (cardBuffer) {
          finalQrBuffer = cardBuffer;
        }
      } catch (e) {
        console.warn('[boss_select_acc] Personalized QR Card generation fallback:', e.message);
      }

      if (finalQrBuffer) {
        order.genuineQrBuffer = finalQrBuffer;
        try {
          const bossQrMsg = await ctx.replyWithPhoto(
            { source: finalQrBuffer },
            {
              caption: `▣ <b>Live Swiggy Checkout Payment QR (Order #${order.id})</b>\n\n` +
                `☎ Account: <b>${escapeHtml(accPhone)}</b> (${escapeHtml(accName)})\n` +
                `◉ Customer Badge in QR Center: <b>${escapeHtml(custDisplayName)}</b>\n` +
                `▣ Restaurant: <b>${escapeHtml(order.restaurantName || 'Swiggy Order')}</b>\n` +
                `₹ Amount To Pay: <b>₹${order.finalPayable || order.subtotal || 0}</b> (Saved: ₹${order.totalSavings || 0})\n\n` +
                `! <i>Yeh Payment QR abhi customer ko nahi bheja gaya hai. Neeche Review Screen check karke <b>[ › Send Bill & Request Confirmation ]</b> dabayein!</i>`,
              parse_mode: 'HTML'
            }
          );
          if (bossQrMsg?.photo && bossQrMsg.photo.length > 0) {
            order.customQrFileId = bossQrMsg.photo[bossQrMsg.photo.length - 1].file_id;
          }
        } catch (e) {
          console.error('[boss_select_acc] Error sending QR preview to boss:', e.message);
        }
      }

      const freshSelectDb = getDb();
      freshSelectDb.orders[order.id] = order;
      saveDb(freshSelectDb);
      try {
        await sendBillSummaryToCustomerOnce(bot.telegram, order, {
          db: getDb(),
          deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary),
          onMessageSent: (sentMsg) => rememberUserCard(order.userChatId || order.userId, sentMsg)
        });
      } catch {}
      order = getDb().orders?.[order.id] || order;

      // Update Customer's card
      await updateOrderCards(order);

      try {
        await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id);
      } catch (e) {}

      // Deliver comprehensive Boss Review Card
      const reviewCard = formatBossAccountReviewCard(order);
      await ctx.reply(reviewCard.text, {
        parse_mode: 'HTML',
        ...reviewCard.keyboard
      });
    } catch (e) {
      console.error('Error syncing group cart and checkout for chosen account:', e.message);
      try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (delErr) {}
      await ctx.reply(`× <b>Failed to process order #${orderId}:</b> ${escapeHtml(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  })().catch(err => console.error('[boss_select_acc] Background Error:', err));
});

// 1-Tap Boss Action: Auto Scan ALL Logged-In Accounts -> Apply Swiggy One Lite (+₹1) + Max Coupon -> Pick Lowest Final Total!
bot.action(/^boss_auto_max_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Scanning all accounts for MAX Coupon + Lowest Bill... ★').catch(() => {});
  const waitMsg = await ctx.reply(
    `★ <b>Auto Max-Coupon & Best Account Engine (#${orderId})...</b>\n\n` +
    `1️⃣ Checking all logged-in Swiggy accounts\n` +
    `2️⃣ Unlocking ₹50 Event Offers & ₹1 Swiggy One Lite Free Delivery\n` +
    `3️⃣ Testing all restaurant & campaign coupons (<code>DELULU4FOOD</code>, <code>STEALDEAL</code>, <code>MEALDEAL</code>, <code>FLAT150</code>, <code>TRYNEW</code>...)\n` +
    `4️⃣ Locking the #1 Lowest <b>Final Total</b> & capturing Payment QR...`,
    { parse_mode: 'HTML' }
  );

  (async () => {
    try {
      const best = await findBestMaxCouponAccountForOrder(order, { captureScreenshot: true });
      if (!best.success) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
        return ctx.reply(`! <b>Max Coupon Scan Failed:</b> ${escapeHtml(best.error || 'No active accounts')}`, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (best.savedAddresses?.length > 0) order.accountAddresses = best.savedAddresses;
      if (best.availableCoupons?.length > 0) order.availableCoupons = best.availableCoupons;
      if (best.paymentUrl) order.swiggyPaymentUrl = best.paymentUrl;
      applyMaxOfferToOrder(order);

      const custDisplayName = order.userName || 'Customer';
      // Boss (30-10-2026): order QR SIRF Swiggy ka (boss ki UPI se nahi).
      const swiggyOnlyUri2 = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
      const upiUri = swiggyOnlyUri2 ? sanitizeUpiUriForQr(swiggyOnlyUri2) : '';

      let finalQrBuffer = best.qrBuffer;
      try {
        const cardBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri,
          qrBuffer: best.qrBuffer
        });
        if (cardBuffer) finalQrBuffer = cardBuffer;
      } catch (e) {}

      const winPhone = best.winningAccount?.phone || best.winningKey;
      const winName = best.winningAccount?.name || winPhone;
      const cmpLines = (best.accountComparison || [])
        .map(c => `• <code>${escapeHtml(c.phone)}</code>: Final Total <b>₹${c.finalPayable}</b>${c.couponCode ? ` (${escapeHtml(c.couponCode)} −₹${c.discountAmount})` : ''}`)
        .join('\n');

      if (finalQrBuffer) {
        order.genuineQrBuffer = finalQrBuffer;
        try {
          const bossQrMsg = await ctx.replyWithPhoto(
            { source: finalQrBuffer },
            {
              caption: `★ <b>MAX COUPON WINNER ACCOUNT LOCKED! (Order #${order.id})</b>\n\n` +
                `★ Winning Account: <b>${escapeHtml(winPhone)}</b> (${escapeHtml(winName)})\n` +
                `# Best Coupon: <b>${escapeHtml(order.couponCode || 'Auto Free Delivery')}</b> (−₹${order.discountAmount || 0})\n` +
                `₹ Total Savings: <b>₹${order.totalSavings || 0}</b>\n` +
                `₹ <b>Final Total: ₹${order.finalPayable || order.subtotal || 0}</b>\n` +
                (cmpLines ? `\n▤ <b>Account Comparison:</b>\n${cmpLines}` : ''),
              parse_mode: 'HTML'
            }
          );
          if (bossQrMsg?.photo?.length > 0) {
            order.customQrFileId = bossQrMsg.photo[bossQrMsg.photo.length - 1].file_id;
          }
        } catch (e) {}
      }

      const freshMaxDb = getDb();
      freshMaxDb.orders[order.id] = order;
      saveDb(freshMaxDb);
      try {
        const summarySend = await sendBillSummaryToCustomerOnce(bot.telegram, order, {
          db: getDb(),
          deliver: (summary) => deliverBillSummaryIntoSingleCard(order, summary),
          onMessageSent: (sentMsg) => rememberUserCard(order.userChatId || order.userId, sentMsg)
        });
        if (summarySend?.sent) console.log(`[MaxCoupon] Bill summary sent for Order #${order.id}`);
      } catch (summaryErr) {
        console.warn('[MaxCoupon] Bill summary skipped:', summaryErr?.message || summaryErr);
      }
      const updatedMaxOrder = getDb().orders?.[order.id] || order;
      await updateOrderCards(updatedMaxOrder);
      try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

      const reviewCard = formatBossAccountReviewCard(order);
      await ctx.reply(reviewCard.text, { parse_mode: 'HTML', ...reviewCard.keyboard });
    } catch (e) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (err) {}
      await ctx.reply(`× <b>Max Coupon Scan Error:</b> ${escapeHtml(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  })().catch(err => console.error('[boss_auto_max_coupon] Error:', err));
});

// Helper: parse `accKey` and optional `orderId` cleanly even when `accKey` contains underscores (`acc_9935123518` or `acc_9935123518_ORD1`)
function resolveAccountPayload(rawPayload) {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  if (accounts[rawPayload]) return { accKey: rawPayload, orderId: null, acc: accounts[rawPayload] };
  for (const k of Object.keys(accounts)) {
    if (rawPayload.startsWith(k + '_')) {
      return { accKey: k, orderId: rawPayload.slice(k.length + 1), acc: accounts[k] };
    }
  }
  const m = rawPayload.match(/^(acc_\d{10})(?:_(.+))?$/);
  if (m) return { accKey: m[1], orderId: m[2] || null, acc: accounts[m[1]] || null };
  return { accKey: rawPayload, orderId: null, acc: accounts[rawPayload] || null };
}

// 1-Tap Direct Re-Login / Re-Create on any 10-digit mobile number (works right after Logout OR Swiggy Delete!)
bot.action(/^relogin_phone_(\d{10})$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const phone = ctx.match[1];
  const db = getDb();
  const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === phone);
  const accKey = existing ? existing[0] : `acc_${phone}`;
  const accName = existing?.[1]?.name || getNextAutoUserName();

  await ctx.answerCbQuery(`Sending OTP to ${phone}... !`).catch(() => {});
  const waitMsg = await ctx.reply(`☎ <b>Requesting Swiggy OTP for <code>${phone}</code>...</b>`, { parse_mode: 'HTML' });

  try {
    const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, accKey, accName);
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      userWaitState[ctx.from.id] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: accKey,
        phone,
        name: accName,
        isNewUser: Boolean(result.isNewUser)
      };
      await ctx.reply(
        `☎ <b>Swiggy OTP Sent!</b>\n` +
        `☎ Mobile: <code>${phone}</code>${result.isNewUser ? ' <i>(Fresh Signup Mode)</i>' : ''}\n\n` +
        `› <i>6-digit OTP yahan type karein:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}`, style: 'primary' },
                { text: '✉ Resend OTP', callback_data: `resend_otp_${phone}`, style: 'primary' }
              ],
              [
                { text: '▤ Paste Session JSON', callback_data: `boss_login_acc_json_${accKey}`, style: 'primary' },
                { text: '× Cancel', callback_data: 'close_menu', style: 'danger' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, { parse_mode: 'HTML', ...errCard.keyboard });
    }
  } catch (err) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    await ctx.reply(`× <b>Error:</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// Boss Action: Trigger Login / Re-Login via OTP for an Account
bot.action(/^boss_login_acc_otp_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const { accKey, orderId, acc } = resolveAccountPayload(ctx.match[1]);
  const rawPhone = acc?.phone || acc?.mobile || accKey.replace(/^acc_/, '');
  const phone = /^\d{10}$/.test(rawPhone) ? rawPhone : '';
  const accName = acc?.name || phone || accKey;

  // If account slot has no phone number yet (newly created slot), ask for the 10-digit number directly!
  if (!phone) {
    await ctx.answerCbQuery().catch(() => {});
    userWaitState[ctx.from.id] = { action: 'waiting_phone_for_otp', targetAcc: accKey, orderId };
    return ctx.reply(
      `☎ <b>Enter 10-digit Mobile Number for "${escapeHtml(accName)}":</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: '10 digits, or 91 + 10 digits...' }
      }
    );
  }

  await ctx.answerCbQuery(`Sending OTP to ${phone}... !`).catch(() => {});
  const waitMsg = await ctx.reply(`☎ <b>Requesting Swiggy OTP for ${escapeHtml(phone)} (${escapeHtml(accName)})...</b>`, { parse_mode: 'HTML' });

  try {
    const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, accKey, accName);
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      userWaitState[ctx.from.id] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: accKey,
        phone,
        name: accName,
        orderId,
        isNewUser: Boolean(result.isNewUser)
      };
      await ctx.reply(
        `☎ <b>Swiggy OTP Sent Successfully!</b>\n` +
        `☎ Mobile: <code>${phone}</code>${result.isNewUser ? ' <i>(Fresh Signup)</i>' : ''}\n` +
        `◉ Account: <b>${escapeHtml(accName)}</b>\n\n` +
        `› <i>Kripya mobile par aaya hua 6-digit OTP yahan type karein:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}`, style: 'primary' },
                { text: '✉ Resend OTP', callback_data: `resend_otp_${phone}`, style: 'primary' }
              ],
              [
                { text: '▤ Paste Session JSON', callback_data: `boss_login_acc_json_${accKey}`, style: 'primary' },
                { text: '× Cancel', callback_data: 'close_menu', style: 'danger' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: { force_reply: true, input_field_placeholder: 'Enter 6-digit OTP...' }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
  } catch (err) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}
    await ctx.reply(`× <b>Error:</b> ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
});

// Boss Action: Prompt to paste Full Session JSON / Code for an Account (Re-Login without OTP!)
bot.action(/^boss_login_acc_json_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const { accKey, orderId, acc } = resolveAccountPayload(ctx.match[1]);
  const phone = acc?.phone || acc?.mobile || accKey.replace(/^acc_/, '');
  const accName = acc?.name || phone || accKey;

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = {
    action: 'waiting_json_login',
    targetAcc: accKey,
    orderId,
    phone
  };

  await ctx.reply(
    `▤ <b>Re-Login / Import Session Code for ${escapeHtml(accName)}${phone ? ` (<code>${escapeHtml(phone)}</code>)` : ''}:</b>\n\n` +
    `Copy kiya hua full Swiggy Session Code (ya <code>.json</code> file) yahan paste karein — bina OTP ke turant re-login ho jayega!`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste full session JSON code here...' }
    }
  );
});

// Boss Action: Add new account directly while handling an order
bot.action(/^boss_add_new_acc_for_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = {
    action: 'waiting_phone_for_new_acc_order',
    orderId
  };

  await ctx.reply(
    `+ <b>Add New Swiggy Account for Order #${orderId}:</b>\n\n` +
    `› <i>Enter 10-digit Mobile Number:</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: '10 digits, or 91 + 10 digits...' }
    }
  );
});

// Boss Action: Back to order review card
bot.action(/^boss_back_to_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  await updateOrderCards(order);
});

// Boss Action: Send Bill & Confirmation Request to Customer
bot.action(/^boss_send_qr_to_user_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  order.paymentSentToUser = true;
  saveDb(db);

  await ctx.answerCbQuery('Sending Bill & Confirmation Request to Customer... ›').catch(() => {});

  // 1. Send Bill & Confirmation Request to Customer
  const custChatId = order.userChatId || order.userId;
  if (custChatId) {
    try {
      if (!order.genuineQrBuffer) {
        const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
        // Boss (30-10-2026): order QR SIRF Swiggy ka (boss ki UPI se nahi).
        const swiggyQrUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
        const upiUri = swiggyQrUri ? sanitizeUpiUriForQr(swiggyQrUri) : '';
        order.genuineQrBuffer = await generatePersonalizedQrCard({
          customerName: custDisplayName,
          restaurantName: order.restaurantName || 'Swiggy Food Order',
          amount: order.finalPayable || order.subtotal || 0,
          savings: order.totalSavings || 0,
          upiUrl: upiUri
        }).catch(err => {
          console.warn('[boss_send_qr_to_user] Card generation fallback:', err.message);
          return null;
        });
        saveDb(db);
      }

      // Send Customer confirmation & payment prompt
      const custDisplayName = order.userName || (order.userRole === 'Abbu' ? 'Abbu' : order.userRole === 'Ammi' ? 'Ammi' : 'Customer');
      const confirmText = `▤ <b>Swiggy Order #${order.id} Ready for Confirmation!</b>\n\n` +
        `◉ <b>Customer:</b> <b>${escapeHtml(custDisplayName)}</b>\n` +
        `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
        `₹ <b>Amount To Pay: ₹${order.finalPayable || order.subtotal || 0}</b>\n` +
        (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved: ₹${order.totalSavings}</b>\n` : '') +
        `\n› <i>Aapka order review ho gaya hai! Neeche <b>[ ✓ Confirm Order & Get Payment QR ]</b> dabakar payment QR prapt karein:</i>`;

      await bot.telegram.sendMessage(
        custChatId,
        confirmText,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('✓ Confirm Order & Get Payment QR', `user_confirm_get_qr_${order.id}`)],
            ...(order.swiggyPaymentUrl ? [[Markup.button.url('₹ Pay on Swiggy (Official Link)', order.swiggyPaymentUrl)]] : []),
            [Markup.button.callback('● Cancel Order', `action_cancel_order_confirm_${order.id}`)]
          ])
        }
      );
    } catch (err) {
      console.error('[boss_send_qr_to_user] Failed to send bill to user:', err.message);
    }
  }

  // 2. Update Customer's main order card
  await updateOrderCards(order);

  // 3. Update Boss review card
  const updatedReview = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(updatedReview.text, {
      parse_mode: 'HTML',
      ...updatedReview.keyboard
    });
  } catch (e) {
    await ctx.reply(updatedReview.text, {
      parse_mode: 'HTML',
      ...updatedReview.keyboard
    });
  }

  await ctx.reply(`✓ <b>Bill & Confirmation Request Customer ko bhej diya gaya hai!</b>\n<i>User ke confirm karte hi QR code unhe send ho jayega.</i>`, { parse_mode: 'HTML' });
});

// Customer Action: Confirm Order & Get Personalized QR Card
bot.action(/^user_confirm_get_qr_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return ctx.answerCbQuery('No payment QR is available for a closed order.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Order Confirmed! Generating your payment QR with your name... ›').catch(() => {});
  await sendPaymentQrToUser(order);
});

// Boss Action: Coupon Picker
bot.action(/^boss_coupon_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});

  const buttons = [];
  const coupons = order.availableCoupons || [];

  for (const c of coupons) {
    const desc = c.description ? ` (${c.description.slice(0, 25)})` : '';
    buttons.push([Markup.button.callback(`# Apply ${c.code}${desc}`, `boss_apply_coupon_${orderId}_${c.code}`)]);
  }

  const defaultCodes = ['DELULU4FOOD', 'SWIGGYIT', 'PARTY', 'STEALDEAL', 'WELCOME50'];
  const missingDefaults = defaultCodes.filter(d => !coupons.some(c => c.code === d));
  if (missingDefaults.length > 0) {
    const row = missingDefaults.slice(0, 3).map(code =>
      Markup.button.callback(`# ${code}`, `boss_apply_coupon_${orderId}_${code}`)
    );
    buttons.push(row);
  }

  if (order.couponCode) {
    buttons.push([Markup.button.callback('× Remove Current Coupon', `boss_remove_coupon_${orderId}`)]);
  }

  buttons.push([Markup.button.callback('← Back to Review Screen', `boss_view_review_${orderId}`)]);

  await ctx.reply(
    `# <b>CHOOSE COUPON FOR ORDER #${orderId}:</b>\n\n` +
    `Current Applied Coupon: <b>${order.couponCode ? escapeHtml(order.couponCode) : 'None'}</b> ` +
    (order.discountAmount > 0 ? `(−₹${order.discountAmount})` : '') + `\n\n` +
    `Select a coupon code to apply to this order:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Boss Action: Apply Coupon (applies live on Swiggy via /dapi/cart/applyCoupon when account is selected!)
bot.action(/^boss_apply_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let code = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.startsWith(oid + '_')) {
      orderId = oid;
      code = payload.slice(oid.length + 1);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) return ctx.answerCbQuery('Order not found').catch(() => {});
  const order = db.orders[orderId];
  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;

  let liveApplied = null;
  if (acc?.cookies) {
    liveApplied = await applyLiveCouponToOrder(acc, order, code).catch(() => null);
  }

  if (liveApplied && liveApplied.items?.length > 0) {
    order.couponCode = liveApplied.couponCode || code;
    order.discountAmount = liveApplied.discountAmount || 0;
    order.deliveryFee = liveApplied.deliveryFee || 0;
    order.packingCharges = liveApplied.packingCharges || 0;
    order.taxesAndCharges = liveApplied.taxesAndCharges || 0;
    order.finalPayable = liveApplied.finalPayable;
    order.totalSavings = liveApplied.totalSavings;
    order.swiggyVerified = true;
  } else {
    order.couponCode = code;
    order.swiggyVerified = false;
    applyMaxOfferToOrder(order);
  }
  saveDb(db);
  await updateOrderCards(order);

  await ctx.answerCbQuery(`Applied coupon ${order.couponCode || code}! ✓`).catch(() => {});

  if (order.isForwardedOrder) {
    await deleteOrderBotMessages(ctx.telegram, order, { deleteCard: true });
    try { await ctx.deleteMessage(); } catch (e) {}
    const fwdView = buildForwardedOrderCardView(order, formatUserOrderCardText);
    const sent = await ctx.reply(fwdView.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...fwdView.keyboard
    });
    order.bossCardChatId = sent.chat?.id ?? ctx.chat?.id;
    order.bossCardMsgId = sent.message_id;
    saveDb(db);
    return;
  }

  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: Remove Coupon
bot.action(/^boss_remove_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  const liveRemoved = acc?.cookies ? await applyLiveCouponToOrder(acc, order, 'REMOVE').catch(() => null) : null;

  order.couponCode = null;
  order.discountAmount = 0;
  if (liveRemoved && liveRemoved.items?.length > 0) {
    order.finalPayable = liveRemoved.finalPayable;
    order.totalSavings = liveRemoved.totalSavings;
    order.swiggyVerified = true;
  } else {
    order.swiggyVerified = false;
    applyMaxOfferToOrder(order);
  }
  saveDb(db);
  await updateOrderCards(order);

  await ctx.answerCbQuery('Coupon removed').catch(() => {});
  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: Address Picker (dynamically fetches saved addresses across accounts if not yet cached)
bot.action(/^boss_addr_picker_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery('Loading saved addresses... ⌖').catch(() => {});
  let addrs = order.accountAddresses || [];
  if (addrs.length === 0) {
    addrs = await fetchAllAccountsSavedAddresses();
    if (addrs.length > 0) {
      order.accountAddresses = addrs;
      saveDb(db);
    }
  }
  const buttons = [];

  addrs.forEach((a, idx) => {
    const tag = a.annotation ? `[${a.annotation}] ` : '';
    const accBadge = a.accountName ? `(${a.accountName}) ` : '';
    const label = `${idx + 1}. ${tag}${accBadge}${(a.address || '').slice(0, 32)}...`;
    buttons.push([Markup.button.callback(label, `boss_set_addr_${orderId}_${idx}`)]);
  });

  buttons.push([Markup.button.callback('← Back to Review Screen', `boss_view_review_${orderId}`)]);

  await ctx.reply(
    `⌖ <b>SELECT ACCOUNT ADDRESS FOR ORDER #${orderId}:</b>\n\n` +
    (addrs.length > 0
      ? `Choose from the saved addresses found on your Swiggy accounts:`
      : `<i>No saved addresses found yet on connected Swiggy accounts.</i>`),
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }
  );
});

// Boss Action: Set Address from Saved List (and live re-sync cart delivery fee when account selected!)
bot.action(/^boss_set_addr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const payload = ctx.match[1];
  const db = getDb();
  let orderId = null;
  let addrIdx = null;

  for (const oid of Object.keys(db.orders || {})) {
    if (payload.startsWith(oid + '_')) {
      orderId = oid;
      addrIdx = parseInt(payload.slice(oid.length + 1), 10);
      break;
    }
  }

  if (!orderId || !db.orders[orderId]) return ctx.answerCbQuery('Order not found').catch(() => {});
  const order = db.orders[orderId];
  const selectedAddr = order.accountAddresses?.[addrIdx];
  if (order.pendingSwiggyOrderId) {
    return ctx.answerCbQuery('Delivery address cannot change after a Swiggy payment order/QR exists.', { show_alert: true }).catch(() => {});
  }

  if (selectedAddr) {
    order.address = selectedAddr.address;
    order.addressOriginalText = selectedAddr.address;
    order.addressLink = null;
    order.addressDetails = {
      id: selectedAddr.id || '',
      name: selectedAddr.name || '',
      mobile: selectedAddr.mobile || '',
      flat_no: selectedAddr.flat_no || '',
      area: selectedAddr.area || '',
      landmark: selectedAddr.landmark || '',
      address: selectedAddr.address || '',
      city: selectedAddr.city || '',
      lat: selectedAddr.lat || '',
      lng: selectedAddr.lng || ''
    };
    const selAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
    let syncError = '';
    if (selAcc?.cookies) {
      const syncRes = await syncGroupCartAndCheckoutForAccount(selAcc, order, { captureScreenshot: false }).catch(e => ({ success: false, error: e.message }));
      if (!syncRes?.success) syncError = syncRes?.error || 'Address could not be verified on the selected Swiggy account.';
    }
    saveDb(db);
    await updateOrderCards(order);
    if (syncError) {
      await ctx.answerCbQuery('Address not verified; checkout is blocked.', { show_alert: true }).catch(() => {});
      await ctx.reply(`× <b>Address not verified:</b> ${escapeHtml(syncError)}\n\n<i>No default address was substituted.</i>`, { parse_mode: 'HTML' }).catch(() => {});
    } else {
      await ctx.answerCbQuery(`Selected address ${addrIdx + 1}! ⌂`).catch(() => {});
    }
  }

  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Boss Action: View Review Screen
bot.action(/^boss_view_review_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  const reviewCard = formatBossAccountReviewCard(order);
  try {
    await ctx.editMessageText(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  } catch (e) {
    await ctx.reply(reviewCard.text, {
      parse_mode: 'HTML',
      ...reviewCard.keyboard
    });
  }
});

// Prompt to add new account from My Swiggy Accounts menu (deduplicated from order handlers above)
bot.action('boss_add_new_account_menu', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});

  userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name', orderId: null };
  await ctx.reply(
    `+ <b>ADD NEW SWIGGY ACCOUNT:</b>\n\n` +
    `Naye account ka naam chat me likhein:\n` +
    `(Jaise: <code>Bhai</code>, <code>Chacha</code>, <code>Personal</code>, <code>Office</code>, <code>Didi</code>):`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter account name (e.g. Bhai)...' }
    }
  );
});

// ================= ACCOUNT MANAGEMENT: DELETE, LOGOUT, REFRESH, EXPORT =================

// State map for multi-select export checklist per user
const exportSelections = {};
// State for Export & Logout (1+ orders) picker
const exportLogoutSelections = {};
const exportLogoutOrderCounts = {};

// 1A. Remove Account Locally from Bot DB (works immediately even if session is logged out or expired!)
bot.action(/^boss_remove_local_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  const phone = acc?.phone || acc?.mobile || key.replace(/^acc_/, '');
  const cleanPhone = normalizeIndianMobileNumber(phone) || '';
  const accName = acc?.name || key;

  const curWait = userWaitState[userId];
  if (curWait && (curWait.targetAcc === key || (cleanPhone && curWait.phone === cleanPhone))) {
    delete userWaitState[userId];
  }

  await deactivateSwiggyAccountViaBridge(userId, key, true).catch(() => {});
  permanentLogoutAccount(key, { purgeVault: true });
  deleteAccount(key, { purgeVault: true });

  await ctx.answerCbQuery('Removed from Bot DB! ×').catch(() => {});
  await ctx.reply(
    `<blockquote>× <b>ACCOUNT REMOVED FROM BOT</b></blockquote>\n\n` +
    `☎ <b>Number:</b> <code>${escapeHtml(phone)}</code>\n` +
    `◉ <b>Name:</b> <b>${escapeHtml(accName)}</b>\n\n` +
    `<i>Account bot list se hata diya gaya hai. Neeche 1-tap se dobara login kar sakte hain:</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          ...(/^\d{10}$/.test(cleanPhone || phone)
            ? [Markup.button.callback(`◈ Re-Login ${cleanPhone || phone} (OTP)`, `relogin_phone_${cleanPhone || phone}`)]
            : [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')]),
          Markup.button.callback('▤ Login with Code', 'boss_login_with_json')
        ],
        [
          Markup.button.callback('◉ View Accounts', 'boss_view_accounts'),
          Markup.button.callback('⌂ Main Menu', 'boss_panel_home')
        ]
      ])
    }
  );
});

// 1B. Clean All Logged-Out / Dead Accounts from Bot DB in 1 Tap
bot.action('boss_clean_dead_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const entries = Object.entries(db.config?.accounts || {});
  let removed = 0;
  for (const [k, a] of entries) {
    if (!isAccountLoggedInSession(a)) {
      if (userWaitState[userId]?.targetAcc === k) {
        delete userWaitState[userId];
      }
      deleteAccount(k, { purgeVault: false, skipImmediateCloudPush: true });
      removed++;
    }
  }
  if (removed > 0) {
    syncCloudVaultNow(getDb()).catch(() => {});
  }
  await ctx.answerCbQuery(`Removed ${removed} logged-out accounts! ×`).catch(() => {});
  await showFamilyAccounts(ctx);
});

// 1. Direct Delete Account Picker (Supports BOTH Swiggy Server Delete via OTP AND Instant Bot Removal!)
bot.action('boss_delete_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};
  const entries = Object.entries(accounts);

  const buttons = [];
  const deadCount = entries.filter(([, a]) => !isAccountLoggedInSession(a)).length;
  if (deadCount > 0) {
    buttons.push([
      { text: `× Remove All Logged-Out (${deadCount}) from Bot`, callback_data: 'boss_clean_dead_accounts', style: 'danger' }
    ]);
  }

  for (const [k, a] of entries) {
    const label = `${a.name || k} (${a.phone || ''})`;
    if (isAccountLoggedInSession(a)) {
      buttons.push([
        { text: `! Swiggy Delete: ${label}`, callback_data: `boss_swiggy_delete_start_${k}`, style: 'danger' },
        { text: `× Bot Remove`, callback_data: `boss_remove_local_${k}`, style: 'primary' }
      ]);
    } else {
      buttons.push([
        { text: `× Remove from Bot: ${label}`, callback_data: `boss_remove_local_${k}`, style: 'danger' },
        { text: `◈ Re-Login`, callback_data: `boss_login_acc_otp_${k}`, style: 'primary' }
      ]);
    }
  }
  buttons.push([{ text: 'Cancel', callback_data: 'boss_view_accounts', style: 'primary' }]);

  await ctx.reply(
    `<b>× Delete / Remove Accounts Manager:</b>\n\n` +
    `• <b>! Swiggy Delete:</b> OTP ke baad Swiggy server se account delete karne ki request karega.\n` +
    `• <b>× Bot Remove:</b> Sirf bot ki list se account hatayega (bina OTP ke turant!).`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }
  );
});

// Mutex to strictly prevent duplicate / concurrent deletion requests
const deleteInProgress = new Set();

bot.action([
  /^boss_swiggy_delete_start_(.+)$/,
  /^boss_swiggy_delete_trigger_(.+)$/,
  /^boss_swiggy_delete_instant_(.+)$/,
  /^boss_swiggy_delete_confirm_(.+)$/
], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const key = ctx.match[1];

  if (deleteInProgress.has(userId) || deleteInProgress.has(key)) {
    return ctx.answerCbQuery('! Swiggy Delete OTP request already in progress... Please wait.', { show_alert: true }).catch(() => {});
  }

  deleteInProgress.add(userId);
  deleteInProgress.add(key);

  const db = getDb();
  const acc = db.config.accounts?.[key];
  if (!acc) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply('× Account not found.');
  }

  const phone = normalizeIndianMobileNumber(acc.phone || acc.mobile || key.replace(/^acc_/, '')) || '';
  const accName = acc.name || key;
  if (!phone) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply(
      `! <b>No valid Indian mobile number is saved for ${escapeHtml(accName)}.</b> Remove it from the bot list or correct the account details first.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`)]]) }
    );
  }

  const isAuth = checkLoggedInFromCookies(acc);
  if (!isAuth && !acc.cookies && !acc.tid) {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
    return ctx.reply(
      `! <b>"${escapeHtml(accName)}" (<code>${escapeHtml(phone)}</code>) abhi Logged Out hai!</b>\n\n` +
      `• Agar sirf <b>Bot list se hatana hai</b> toh <b>× Remove from Bot DB</b> dabayein.\n` +
      `• Agar <b>Swiggy server se delete</b> karna hai toh pehle <b>◈ Login via OTP</b> dabayein:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('× Remove from Bot DB', `boss_remove_local_${key}`),
            Markup.button.callback(`◈ Login ${accName}`, `boss_login_acc_otp_${key}`)
          ],
          [Markup.button.callback('Main Menu', 'boss_panel_home')]
        ])
      }
    );
  }

  await ctx.answerCbQuery('Requesting Authentic Swiggy Delete OTP... ◷').catch(() => {});
  userWaitState[userId] = {
    action: 'initiating_swiggy_delete_otp',
    phone,
    accountKey: key,
    accName,
    startedAt: Date.now()
  };

  try {
    const otpResult = await requestSwiggyDeleteOtpViaBridge(userId, phone, key, accName);
    if (otpResult.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_delete_otp',
        phone,
        accountKey: key,
        accName,
        startedAt: Date.now()
      };

      await ctx.reply(
        otpSentCard(phone, [`× Delete OTP for account: <b>${escapeHtml(accName)}</b>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Copy Number', copy_text: { text: phone }, style: 'primary' }],
              [
                { text: 'Resend Delete OTP', callback_data: `boss_swiggy_delete_start_${key}`, style: 'primary' },
                { text: '× Remove from Bot Only', callback_data: `boss_remove_local_${key}`, style: 'danger' }
              ],
              [
                { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' },
                { text: 'Close', callback_data: 'close_menu', style: 'danger' }
              ]
            ]
          }
        }
      );

      await ctx.reply('› Enter 6-digit Delete OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit Delete OTP...'
        }
      });
    } else {
      delete userWaitState[userId];
      const errText = otpResult.swiggyStatus || otpResult.message || 'Failed to trigger Delete OTP';
      const isAuthError = Boolean(otpResult.isAuthError);
      const securityBlocked = otpResult.code === 'SWIGGY_SECURITY_CHALLENGE' || otpResult.code === 'SWIGGY_RATE_LIMIT';
      if (isAuthError && db.config.accounts?.[key]) {
        db.config.accounts[key].isLoggedIn = false;
        saveDb(db);
      }
      const actionButtons = securityBlocked
        ? [
            [Markup.button.url('Open official Swiggy settings', 'https://www.swiggy.com/my-account/settings')],
            [Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`)],
            [Markup.button.callback('Main Menu', 'boss_panel_home')]
          ]
        : [
            [
              Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`),
              isAuthError
                ? Markup.button.callback(`Re-Login ${phone}`, `boss_login_acc_otp_${key}`)
                : Markup.button.callback('Retry Delete OTP', `boss_swiggy_delete_start_${key}`)
            ],
            [Markup.button.callback('Main Menu', 'boss_panel_home')]
          ];
      await ctx.reply(
        `<blockquote>${escapeHtml(errText)}</blockquote>\n\n` +
        (securityBlocked
          ? `! <b>Swiggy stopped this request. The bot did not retry or bypass the security check.</b>\nUse the official Swiggy settings page to finish deletion, or remove only the saved bot entry. `
          : `! <b>Swiggy Deletion OTP trigger nahi ho paya.</b>\nYou can remove only the bot entry, re-login, or try again later.`),
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: actionButtons } }
      );
    }
  } catch (err) {
    delete userWaitState[userId];
    await ctx.reply(`! Error triggering deletion: ${escapeHtml(err.message)}`);
  } finally {
    deleteInProgress.delete(userId);
    deleteInProgress.delete(key);
  }
});

// 2. Interactive Multi-Select Export Checklist
bot.action(['boss_export_picker', 'boss_exp_select_all', 'boss_exp_deselect_all', /^boss_exp_toggle_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const accKeys = Object.keys(accounts);

  if (accKeys.length === 0) {
    await ctx.answerCbQuery('Koi account nahi mila!', { show_alert: true }).catch(() => {});
    return ctx.reply('! No accounts found in bot to export.');
  }

  if (!exportSelections[userId]) {
    exportSelections[userId] = {};
    accKeys.forEach(k => { exportSelections[userId][k] = Boolean(accounts[k]?.isLoggedIn || exportSessionJson(k)); });
  }

  const actionMatch = ctx.callbackQuery?.data;
  if (actionMatch === 'boss_exp_select_all') {
    accKeys.forEach(k => { exportSelections[userId][k] = true; });
    await ctx.answerCbQuery('Sabhi select ho gaye ✓').catch(() => {});
  } else if (actionMatch === 'boss_exp_deselect_all') {
    accKeys.forEach(k => { exportSelections[userId][k] = false; });
    await ctx.answerCbQuery('Sabhi unselect ho gaye ○').catch(() => {});
  } else if (actionMatch?.startsWith('boss_exp_toggle_')) {
    const toggleKey = actionMatch.replace('boss_exp_toggle_', '');
    exportSelections[userId][toggleKey] = !exportSelections[userId][toggleKey];
    await ctx.answerCbQuery().catch(() => {});
  } else {
    await ctx.answerCbQuery().catch(() => {});
  }

  const currentSelection = exportSelections[userId];
  const allSelected = accKeys.every(k => currentSelection[k]);
  const selectedCount = accKeys.filter(k => currentSelection[k]).length;

  const buttons = [];
  if (allSelected) {
    buttons.push([{ text: 'Deselect All', callback_data: 'boss_exp_deselect_all', style: 'primary' }]);
  } else {
    buttons.push([{ text: 'Select All', callback_data: 'boss_exp_select_all', style: 'primary' }]);
  }

  for (const k of accKeys) {
    const acc = accounts[k];
    const isChecked = Boolean(currentSelection[k]);
    const checkIcon = isChecked ? '✓' : '□';
    const liveBadge = acc.isLoggedIn ? '●' : '○';
    const accLabel = `${checkIcon} ${liveBadge} ${acc.name || k} (${acc.phone || ''})`;
    buttons.push([{ text: accLabel, callback_data: `boss_exp_toggle_${k}`, style: isChecked ? 'success' : 'primary' }]);
  }

  buttons.push([
    { text: `Confirm & Export (${selectedCount}/${accKeys.length})`, callback_data: 'boss_exp_confirm', style: 'success' }
  ]);
  buttons.push([{ text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' }]);

  const checklistText =
    `<blockquote>↑ <b>EXPORT ACCOUNTS CHECKLIST</b></blockquote>\n\n` +
    `Jin accounts ko export karna chahte hain unhe select karein:\n` +
    `• <b>Selected:</b> <b>${selectedCount} of ${accKeys.length} accounts</b>\n\n` +
    `<i>Confirm karte hi har account ki full <code>.json</code> file (with complete cookies) + 1-Click <b>Copy Code</b> button mil jayega!</i>`;

  try {
    await ctx.editMessageText(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    await ctx.reply(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  }
});

// Single Account Export Handler (Full Session JSON with complete cookies + 1-Click Full Copy)
bot.action([/^boss_export_single_(.+)$/, /^boss_export_json_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});

  await ctx.answerCbQuery('Exporting FULL session JSON... ▣').catch(() => {});

  // Size measured before sending — a long session can never 400 with
  // "message is too long" and kill the export.
  const payload = buildExportPayload(acc, key, { orderCount: acc.totalOrdersCount || 0 });
  const { jsonText: jsonStr, compact: compactStr, phone, fileName } = payload;

  try {
    await ctx.replyWithDocument(
      { source: Buffer.from(jsonStr, 'utf-8'), filename: fileName },
      {
        caption: `▣ <b>Session File:</b> <code>${escapeHtml(fileName)}</code> (${jsonStr.length} chars)\n◉ <b>Account:</b> ${escapeHtml(acc.name || key)}\n<i>7 fields: name, customerId, mobile, token, tid, sid, deviceId</i>`,
        parse_mode: 'HTML'
      }
    );
  } catch (err) {
    return ctx.reply(`× Export failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }

  try {
    await ctx.reply(
      `<b>Session Code</b> <code>${escapeHtml(phone)}</code> (${escapeHtml(acc.name || key)})` +
      (payload.inlineCode
        ? `\n<pre><code class="language-json">${escapeHtml(payload.inlineCode)}</code></pre>`
        : `\n<i>Poora JSON upar file me hai (bada session).</i>`),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              makeFullSessionCopyButton(ctx, '▤ Copy Session JSON', key, compactStr, `acc_copy_json_${key}`, 'success'),
              { text: '☎ Copy Number', copy_text: { text: phone }, style: 'primary' }
            ],
            [
              { text: 'Back to Accounts', callback_data: 'acc_refresh_list', style: 'primary' },
              { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    await ctx.reply(`▣ ${escapeHtml(fileName)} bhej diya (code message skip: ${escapeHtml(String(err.message || err).slice(0, 90))})`, { parse_mode: 'HTML' }).catch(() => {});
  }
});

// Confirm Multi-Select Export -> Sends separate full `.json` file + 1-Click Full Copy button per account
bot.action('boss_exp_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const currentSelection = exportSelections[userId] || {};
  const selectedKeys = Object.keys(accounts).filter(k => currentSelection[k]);

  if (selectedKeys.length === 0) {
    // A stale card (or a fresh process) has no selection in memory: reopen the
    // checklist instead of dead-ending on an error popup.
    await ctx.answerCbQuery('Checklist dobara khol raha hoon — account select karein').catch(() => {});
    return ctx.reply('↑ <b>Export checklist</b> — export karne ke liye pehle accounts select karein:', { parse_mode: 'HTML' });
  }

  await ctx.answerCbQuery(`Exporting ${selectedKeys.length} accounts... ▣`).catch(() => {});

  let okCount = 0;
  const failedKeys = [];
  try {
    for (const key of selectedKeys) {
      const acc = accounts[key];
      if (!acc) { failedKeys.push(key); continue; }
      // Per-account isolation: one bad send can never abort the whole batch
      // (that is exactly how 13 accounts silently stayed exported-but-not-sent).
      const payload = buildExportPayload(acc, key, { orderCount: acc.totalOrdersCount || 0 });
      const { jsonText: jsonStr, compact: compactStr, phone, fileName } = payload;

      try {
        await ctx.replyWithDocument(
          { source: Buffer.from(jsonStr, 'utf-8'), filename: fileName },
          {
            caption: `▣ <code>${escapeHtml(fileName)}</code> — ${escapeHtml(acc.name || key)}\n<i>7 fields: name, customerId, mobile, token, tid, sid, deviceId</i>`,
            parse_mode: 'HTML'
          }
        );
        okCount++;
      } catch (err) {
        failedKeys.push(`${acc.phone || key}: ${String(err.message || err).slice(0, 80)}`);
        continue;
      }

      try {
        await ctx.reply(
          `<b>${escapeHtml(acc.name || key)}</b> (<code>${escapeHtml(phone)}</code>)` +
          (payload.inlineCode
            ? `:\n<pre><code class="language-json">${escapeHtml(payload.inlineCode)}</code></pre>`
            : `:\n<i>Poora JSON upar file me hai.</i>`),
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  makeFullSessionCopyButton(ctx, '▤ Copy Session JSON', key, compactStr, `acc_copy_json_${key}`, 'success'),
                  { text: '☎ Copy Number', copy_text: { text: phone }, style: 'primary' }
                ]
              ]
            }
          }
        );
      } catch { /* file is the deliverable; card is best-effort */ }
    }

    await ctx.reply(
      `✓ <b>Export Complete:</b> ${okCount}/${selectedKeys.length} accounts exported (7-field JSON files).` +
      (failedKeys.length ? `\n× Failed: ${failedKeys.map((f) => escapeHtml(f)).join(', ')}` : ''),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'View Accounts', callback_data: 'boss_view_accounts', style: 'primary' },
              { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    await ctx.reply(`× Export error: ${err.message}`);
  }
});

// Fallback callback for non-private chats -> sends 1-tap `<code>` AND `<pre><code class="language-json">` with 100% FULL session JSON!
bot.action(/^copy_code_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc && !exportSessionJson(key)) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  const exported = exportSessionJson(key) || acc;
  const compactStr = JSON.stringify(exported);

  await ctx.answerCbQuery('1 tap on code below copies FULL session! ▤').catch(() => {});
  await ctx.reply(
    `▤ <b>Tap anywhere on code below to copy 100% FULL code (${compactStr.length} chars):</b>\n\n` +
    `<code>${escapeHtml(compactStr)}</code>`,
    { parse_mode: 'HTML' }
  );
});

// 3. Logout Accounts Picker & Logout All
bot.action('boss_logout_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};

  const allEntries = Object.entries(accounts);
  if (allEntries.length === 0) {
    return ctx.reply(
      '! <b>Koi bhi connected account nahi hai!</b>\nNiche se account login ya re-login karein:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('☎ Login with Number', 'boss_login_with_number'),
            Markup.button.callback('▤ Login with Code', 'boss_login_with_json')
          ],
          [Markup.button.callback('◉ View All Accounts', 'boss_view_accounts')]
        ])
      }
    );
  }

  const buttons = [];
  buttons.push([{ text: '! LOGOUT ALL ACCOUNTS', callback_data: 'boss_logout_all_confirm', style: 'danger' }]);

  for (const [k, a] of allEntries) {
    const isLive = isAccountLoggedInSession(a);
    const cnt = typeof a.totalOrdersCount === 'number' ? a.totalOrdersCount : (typeof a.cachedTotalOrdersCount === 'number' ? a.cachedTotalOrdersCount : null);
    const ordBadge = cnt === 0 ? '[0 ord]' : (cnt !== null ? `[${cnt} ord]` : '');
    const statusIcon = isLive ? '●' : (a.sessionExpired ? '⚠️' : '○');
    buttons.push([{ text: `↗ Logout ${statusIcon} ${a.name || k} (${a.phone || ''}) ${ordBadge}`.trim(), callback_data: `boss_logout_single_${k}`, style: isLive ? 'primary' : 'danger' }]);
  }
  buttons.push([{ text: '← Back', callback_data: 'boss_view_accounts', style: 'primary' }]);

  await ctx.reply(
    `<blockquote>↗ <b>LOGOUT ACCOUNTS MANAGER</b></blockquote>\n\n` +
    `Jis account ko bot se logout karna chahte hain uspe tap karein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }
  );
});

bot.action(/^boss_logout_single_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config.accounts?.[key] || db.sessionVault?.[key] || null;

  const phone = acc?.phone || acc?.mobile || key.replace(/^acc_/, '');
  const cleanPhone = normalizeIndianMobileNumber(phone) || '';
  const accName = acc?.name || key;
  await deactivateSwiggyAccountViaBridge(ctx.from.id, key, true).catch(() => {});
  permanentLogoutAccount(key, { purgeVault: true });
  deleteAccount(key, { purgeVault: true });

  await ctx.answerCbQuery('Logged out cleanly! ✓').catch(() => {});
  await ctx.reply(
    `<blockquote>↗ <b>LOGOUT COMPLETED</b></blockquote>\n\n` +
    `☎ <b>Account:</b> <code>${escapeHtml(phone)}</code>\n` +
    `◉ <b>Name:</b> <b>${escapeHtml(accName)}</b>\n` +
    `◈ <b>Status:</b> Completely Logged Out & Purged from Bot.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          ...(/^\d{10}$/.test(cleanPhone || phone)
            ? [Markup.button.callback(`◈ Re-Login ${cleanPhone || phone} (OTP)`, `relogin_phone_${cleanPhone || phone}`)]
            : [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')]),
          Markup.button.callback('▤ Login with Code', 'boss_login_with_json')
        ],
        [
          Markup.button.callback('◉ View Accounts', 'boss_view_accounts'),
          Markup.button.callback('⌂ Main Menu', 'boss_panel_home')
        ]
      ])
    }
  );
});

bot.action('boss_logout_all_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `<blockquote>! <b>CONFIRM LOGOUT ALL</b></blockquote>\n\n` +
    `Kya aap sach me <b>SABHI accounts</b> ko ek sath logout karna chahte hain?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('● Yes, Logout All Accounts', 'boss_logout_all_exec'),
          Markup.button.callback('← Cancel', 'boss_logout_picker')
        ]
      ])
    }
  );
});

bot.action('boss_logout_all_exec', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const allKeys = Object.keys(db.config?.accounts || {});
  for (const k of allKeys) {
    await deactivateSwiggyAccountViaBridge(ctx.from.id, k, true).catch(() => {});
  }
  const count = logoutAllAccounts({ purgeVault: true });
  // The profile cache lives in swiggy-cart.js; clearing it through the exported
  // helper avoids the old `accountOrderProfileCache is not defined` crash.
  // No argument = clear the whole cache (an object argument would be used as a key).
  try { invalidateAccountOrderProfileCache(); } catch (e) { console.warn('[LogoutAll] profile cache clear skipped:', e?.message || e); }

  await ctx.reply(
    `<blockquote>↗ <b>ALL ACCOUNTS LOGGED OUT & PURGED</b></blockquote>\n\n` +
    `Total <b>${count} accounts</b> successfully logout kar diye gaye hain.\n` +
    `Bot DB & Session Vault puri tarah se clear ho chuka hai.\n\n` +
    `Ab aap naye accounts <b>File (.json)</b> ya <b>Phone Number (OTP)</b> se login kar sakte hain:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('☎ Login with Number', 'boss_login_with_number'),
          Markup.button.callback('▤ Login with JSON', 'boss_login_with_json')
        ],
        [Markup.button.callback('◉ View Accounts', 'boss_view_accounts')],
        [Markup.button.callback('⌂ Main Menu', 'boss_panel_home')]
      ])
    }
  );
});

// Lightweight concurrency runner for account batch checks
async function runWithConcurrency(items, limit, workerFn) {
  const results = [];
  const running = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => workerFn(item));
    results.push(p);
    running.add(p);
    p.finally(() => running.delete(p));
    if (running.size >= limit) {
      await Promise.race(running);
    }
  }
  return Promise.allSettled(results);
}

// ===== 3B. Export & Logout =====
async function buildExportLogoutChecklist(ctx, orderCounts, selections) {
  const db = getDb();
  const accounts = db.config.accounts || {};
  const allKeys = Object.keys(accounts);

  const selectedCount = allKeys.filter(k => selections[k]).length;
  const totalCount = allKeys.length;

  const buttons = [];
  if (totalCount > 0) {
    const allSelected = allKeys.length > 0 && allKeys.every(k => selections[k]);
    buttons.push([{
      text: allSelected ? 'Deselect All' : 'Select All',
      callback_data: allSelected ? 'boss_exlo_deselect_all' : 'boss_exlo_select_all',
      style: 'primary'
    }]);
  }

  for (const k of allKeys) {
    const acc = accounts[k];
    const cnt = orderCounts[k] ?? (typeof acc.totalOrdersCount === 'number' ? acc.totalOrdersCount : 0);
    const isChecked = Boolean(selections[k]);
    const checkIcon = isChecked ? '✓' : '□';
    const liveBadge = acc.isLoggedIn ? '●' : '○';
    const label = `${checkIcon} ${liveBadge} ${acc.name || k} (${acc.phone || ''}) — ${cnt} order${cnt === 1 ? '' : 's'}`;
    buttons.push([{
      text: label,
      callback_data: `boss_exlo_toggle_${k}`,
      style: isChecked ? 'success' : 'primary'
    }]);
  }

  if (totalCount > 0) {
    buttons.push([{
      text: `Confirm Export & Logout (${selectedCount}/${totalCount})`,
      callback_data: 'boss_exlo_confirm',
      style: 'success'
    }]);
  }
  buttons.push([{ text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' }]);

  const usedCount = allKeys.filter(k => (orderCounts[k] || 0) >= 1).length;
  const zeroCount = allKeys.filter(k => (orderCounts[k] || 0) === 0).length;

  const checklistText =
    `<blockquote>⇧ <b>EXPORT & LOGOUT ACCOUNTS</b></blockquote>\n\n` +
    `Accounts select karein jinhe aap bot se <b>export aur permanently logout</b> karna chahte hain:\n` +
    `• <b>Total Accounts:</b> <b>${totalCount}</b>\n` +
    `• 📦 <b>Used IDs (1+ Orders):</b> <b>${usedCount}</b> <i>(Auto-selected ✓)</i>\n` +
    `• 🟢 <b>Fresh 0-Order IDs:</b> <b>${zeroCount}</b> <i>(Protected ○)</i>\n` +
    `• <b>Selected for Logout:</b> <b>${selectedCount}/${totalCount}</b>\n\n` +
    (selectedCount > 0
      ? `<i>Confirm karte hi har selected account ki <code>.json</code> session file Telegram par aayegi aur account safely logout ho jayega!</i>`
      : `<i>Koi account select nahi hai. Accounts par tap karke select karein ya 'Select All' dabayein.</i>`);

  try {
    await ctx.editMessageText(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    await ctx.reply(checklistText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  }
}

// Shared by the picker button and by `boss_exlo_confirm`'s state-loss fallback
async function openExportLogoutPicker(ctx, { note = '' } = {}) {
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const accKeys = Object.keys(accounts);
  if (accKeys.length === 0) {
    await ctx.answerCbQuery('Koi account nahi mila!', { show_alert: true }).catch(() => {});
    return ctx.reply('! No accounts found to export.');
  }

  await ctx.answerCbQuery('Checking orders & accounts... ⏳').catch(() => {});
  let statusMsg = null;
  try {
    statusMsg = await ctx.reply('⏳ <i>Accounts ke live orders check ho rahe hain... Isme 2-4 sec lag sakte hain</i>', { parse_mode: 'HTML' });
  } catch (e) {}

  // Pre-warm shared WAF token first so calls don't get challenged
  await getCachedWafToken(false).catch(() => {});

  const orderCounts = {};
  const activeEntries = Object.entries(accounts).filter(([, a]) => a && (a.isLoggedIn || a.cookies || a.tid));

  if (activeEntries.length === 0) {
    if (statusMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    return ctx.reply('! <b>Koi bhi logged-in account nahi hai!</b> Pehle login karein.', { parse_mode: 'HTML' });
  }

  // Fast order count fetch using dapiFetch('order/all') directly with concurrency = 5 and 40ms pacing
  const fetchSingleOrderCount = async ([key, acc]) => {
    try {
      const orderRes = await dapiFetch(acc, 'order/all', { timeoutMs: 6000 }).catch(() => null);
      if (orderRes?.status === 200 && orderRes.json?.statusCode === 0) {
        const list = Array.isArray(orderRes.json.data?.orders) ? orderRes.json.data.orders : [];
        const cnt = list.length;
        acc.totalOrdersCount = cnt;
        acc.isZeroOrderAccount = (cnt === 0);
        return { key, cnt };
      }
      const cached = typeof acc.totalOrdersCount === 'number' ? acc.totalOrdersCount : (typeof acc.cachedTotalOrdersCount === 'number' ? acc.cachedTotalOrdersCount : null);
      if (cached !== null) {
        return { key, cnt: cached };
      }
      return { key, cnt: 0 };
    } catch {
      return { key, cnt: typeof acc.totalOrdersCount === 'number' ? acc.totalOrdersCount : 0 };
    }
  };

  const results = await runWithConcurrency(activeEntries, 5, async (entry) => {
    const res = await fetchSingleOrderCount(entry);
    await new Promise(r => setTimeout(r, 40));
    return res;
  });

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      orderCounts[r.value.key] = r.value.cnt;
    }
  }

  // Also consider db-tracked completed orders as valid
  const dbOrders = Object.values(db.orders || {}).filter(o => o.status === 'COMPLETED' || o.swiggyOrderId);
  for (const dbo of dbOrders) {
    if (dbo.selectedAccount && !(dbo.selectedAccount in orderCounts)) orderCounts[dbo.selectedAccount] = 1;
    else if (dbo.selectedAccount && orderCounts[dbo.selectedAccount] === 0) orderCounts[dbo.selectedAccount] = Math.max(orderCounts[dbo.selectedAccount], 1);
    if (dbo.orderAccount) {
      for (const [k, a] of Object.entries(accounts)) {
        if (a.phone && String(dbo.orderAccount).includes(a.phone) && (orderCounts[k] ?? 0) === 0) orderCounts[k] = 1;
      }
    }
  }

  for (const k of accKeys) {
    if (!(k in orderCounts)) {
      orderCounts[k] = typeof accounts[k]?.totalOrdersCount === 'number' ? accounts[k].totalOrdersCount : 0;
    }
  }

  saveDb(db);

  if (statusMsg) try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}

  exportLogoutSelections[userId] = {};
  exportLogoutOrderCounts[userId] = orderCounts;

  // Auto-select ONLY used accounts with 1+ orders (preserving fresh 0-order accounts in Vault)!
  for (const k of accKeys) {
    const isAvailable = Boolean(accounts[k]?.isLoggedIn || accounts[k]?.cookies || accounts[k]?.tid || exportSessionJson(k));
    const cnt = Number(orderCounts[k] || 0);
    exportLogoutSelections[userId][k] = isAvailable && cnt >= 1;
  }

  if (note) {
    try { await ctx.reply(note, { parse_mode: 'HTML' }); } catch {}
  }

  await buildExportLogoutChecklist(ctx, orderCounts, exportLogoutSelections[userId]);
}

bot.action('boss_export_logout_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await openExportLogoutPicker(ctx);
});

// Toggle / Select All / Deselect All for Export & Logout
bot.action(['boss_exlo_select_all', 'boss_exlo_deselect_all', /^boss_exlo_toggle_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;
  const db = getDb();
  const accounts = db.config.accounts || {};
  const accKeys = Object.keys(accounts);
  if (!exportLogoutSelections[userId]) exportLogoutSelections[userId] = {};
  if (!exportLogoutOrderCounts[userId]) exportLogoutOrderCounts[userId] = {};

  const data = ctx.callbackQuery?.data || '';
  if (data === 'boss_exlo_select_all') {
    for (const k of accKeys) exportLogoutSelections[userId][k] = true;
    await ctx.answerCbQuery('All selected ✓').catch(() => {});
  } else if (data === 'boss_exlo_deselect_all') {
    for (const k of accKeys) exportLogoutSelections[userId][k] = false;
    await ctx.answerCbQuery('All deselected ○').catch(() => {});
  } else if (data.startsWith('boss_exlo_toggle_')) {
    const toggleKey = data.replace('boss_exlo_toggle_', '');
    exportLogoutSelections[userId][toggleKey] = !exportLogoutSelections[userId][toggleKey];
    await ctx.answerCbQuery().catch(() => {});
  }

  await buildExportLogoutChecklist(ctx, exportLogoutOrderCounts[userId], exportLogoutSelections[userId]);
});

// Confirm Export & Logout
bot.action('boss_exlo_confirm', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.from.id;

  if (!exportLogoutSelections[userId] || Object.keys(exportLogoutSelections[userId]).length === 0) {
    await ctx.answerCbQuery('Selection reset ho gayi thi (bot restart) — picker dobara khula hai…', { show_alert: true }).catch(() => {});
    await openExportLogoutPicker(ctx, { note: '⚠ <b>Pichhli selection bot-restart me reset ho gayi thi.</b> Apne accounts dobara select karke <b>CONFIRM</b> dabayein.' });
    return;
  }

  const db0 = getDb();
  const accounts0 = db0.config.accounts || {};
  const selections = exportLogoutSelections[userId] || {};
  const orderCounts = exportLogoutOrderCounts[userId] || {};

  const selectedKeys = Object.keys(accounts0).filter(k => selections[k]);

  if (selectedKeys.length === 0) {
    return ctx.answerCbQuery('Koi account select nahi hai! Kripya select karein.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery(`Exporting & logging out ${selectedKeys.length} accounts... ⇧`).catch(() => {});
  const statusMsg = await ctx.reply(`⏳ <b>Export & Logout shuru:</b> ${selectedKeys.length} accounts — pehle file export, phir permanent logout...`, { parse_mode: 'HTML' });

  let exportedCount = 0;
  let loggedOutCount = 0;
  const skippedDetails = [];

  for (const key of selectedKeys) {
    const acc = getDb().config.accounts?.[key];
    if (!acc) {
      skippedDetails.push(`${key}: not found`);
      continue;
    }
    const cnt = orderCounts[key] ?? acc.totalOrdersCount ?? 0;

    const exported = exportSessionJson(key) || acc;
    if (!exported || (!exported.cookies && !acc.cookies && !acc.tid && !exported.tid)) {
      skippedDetails.push(`${acc.phone || key}: export failed (no session)`);
      continue;
    }

    // Portable 7-field JSON (name, customerId, mobile, token, tid, sid, deviceId)
    // with the message size measured BEFORE sending, so "message is too long"
    // can never happen again (it used to abort the loop and skip the logout).
    const payload = buildExportPayload(acc, key, { orderCount: cnt });
    const jsonStr = payload.jsonText;
    const compactStr = payload.compact;
    const phone = payload.phone;
    const fileName = payload.fileName;

    // The .json FILE is the deliverable. A big inline <pre> used to blow past
    // Telegram's 4096-char limit ("message is too long"), which then aborted the
    // whole loop and left the account NOT logged out. File first, always.
    try {
      await ctx.replyWithDocument(
        { source: Buffer.from(jsonStr, 'utf-8'), filename: fileName },
        {
          caption:
            `⇧ <b>Exported &amp; Logged Out:</b> <code>${escapeHtml(fileName)}</code> (${cnt} orders) — ${escapeHtml(acc.name || key)}\n` +
            `<i>7 fields: name, customerId, mobile, token, tid, sid, deviceId</i>`,
          parse_mode: 'HTML'
        }
      );
      exportedCount++;
    } catch (err) {
      await ctx.reply(`× Export failed for ${escapeHtml(acc.phone || key)}: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
      continue;
    }

    // Optional inline code + copy buttons: best-effort, never blocks logout.
    try {
      const inlineCode = payload.inlineCode;
      await ctx.reply(
        `<b>${escapeHtml(acc.name || key)}</b> (<code>${escapeHtml(phone)}</code>) — <b>${cnt} orders</b>` +
        (inlineCode ? `\n<pre><code class="language-json">${escapeHtml(inlineCode)}</code></pre>` : `\n<i>Poora JSON upar file me hai.</i>`),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [ makeFullSessionCopyButton(ctx, '▤ Copy Session JSON', key, compactStr, `acc_copy_json_${key}`, 'success'),
                { text: '☎ Copy Number', copy_text: { text: phone }, style: 'primary' } ]
            ]
          }
        }
      );
    } catch (cdErr) {
      await ctx.reply(`▤ ${escapeHtml(fileName)} bhej diya (code message skip: ${escapeHtml(String(cdErr.message || cdErr).slice(0, 90))})`, { parse_mode: 'HTML' }).catch(() => {});
    }

    // Now logout only after successful export
    try {
      await deactivateSwiggyAccountViaBridge(ctx.from.id, key, true).catch(() => {});
      permanentLogoutAccount(key, { purgeVault: true });
      deleteAccount(key, { purgeVault: true });
      loggedOutCount++;
    } catch (e) {
      await ctx.reply(`⚠️ Export hua par logout fail for ${escapeHtml(phone)}: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
    }

    // Small delay to avoid Telegram flood control
    await new Promise(r => setTimeout(r, 450));
  }

  try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}

  await ctx.reply(
    `<blockquote>⇧ <b>EXPORT & LOGOUT COMPLETE</b></blockquote>\n\n` +
    `• <b>Exported:</b> ${exportedCount} accounts (JSON files sent above)\n` +
    `• <b>Logged out:</b> ${loggedOutCount} accounts permanently removed\n` +
    (skippedDetails.length ? `\n<i>${skippedDetails.map(s => escapeHtml(s)).join('\n')}</i>` : ``) +
    `\n\n<i>Sabhi exported accounts ki files aur session codes upar send ho gaye hain aur bot se unhe safely logout kar diya gaya hai.</i>`,
    {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    }
  );

  delete exportLogoutSelections[userId];
  delete exportLogoutOrderCounts[userId];
});

// Contact shares are only meaningful for the recipient-mobile step; every other
// case is answered by the real handlers further down (the old demo echo here
// also shadowed the real location intake, so a shared pin never became an address).

// 4. Refresh All Accounts (Audit Session WITHOUT stale AWS WAF false-403 bug!)
bot.action('boss_refresh_all_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery('Auditing all accounts... ◷').catch(() => {});

  const statusMsg = await ctx.reply('◷ <i>Swiggy se sabhi accounts ke live sessions aur orders verify ho rahe hain...</i>', { parse_mode: 'HTML' });

  const db = getDb();
  const accounts = db.config.accounts || {};
  const entries = Object.entries(accounts);

  if (entries.length === 0) {
    try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    return ctx.reply('! No accounts found to refresh.');
  }

  const reportItems = [];

  for (let i = 0; i < entries.length; i++) {
    const [key, acc] = entries[i];
    const phone = acc.phone || key.replace('acc_', '');
    const accName = acc.name || key;
    const rawCookie = acc.cookies || (acc.tid ? `tid=${acc.tid}; _sid=${acc.sid || ''}; _device_id=${acc.deviceId || ''}; token=${acc.token || ''}` : '');
    const cookieStr = stripStaleWafCookie(rawCookie);

    if (!cookieStr) {
      acc.isLoggedIn = false;
      reportItems.push(
        `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
        `• ◈ <b>Session:</b> ○ <b>Logged Out</b>\n`
      );
      continue;
    }

    try {
      const orderOut = await dapiFetch(acc, 'order/all', { timeoutMs: 12000 });
      const json = orderOut?.json;
      const statusCode = json?.statusCode;

      if (orderOut?.status === 200 && json && statusCode === 0) {
        acc.isLoggedIn = true;
        if (json.tid) acc.tid = json.tid;
        const orders = json.data?.orders || [];
        if (orders.length > 0) {
          acc.totalOrdersCount = orders.length;
          acc.cachedTotalOrdersCount = orders.length;
          acc.isZeroOrderAccount = false;
          const latest = orders[0];
          const orderTotal = latest.order_total || latest.net_total || 'N/A';
          reportItems.push(
            `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• ◈ <b>Session:</b> ● <b>Active</b> | ▣ ${orders.length} orders (Latest: #${latest.order_id || latest.id || ''} — ₹${orderTotal})\n`
          );
        } else {
          acc.totalOrdersCount = 0;
          acc.cachedTotalOrdersCount = 0;
          acc.isZeroOrderAccount = true;
          reportItems.push(
            `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• ◈ <b>Session:</b> ● <b>Active (Fresh ID — 0 Orders)</b>\n`
          );
        }
      } else if (statusCode === 1) {
        acc.isLoggedIn = false;
        acc.sessionExpired = true;
        reportItems.push(
          `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
          `• ◈ <b>Session:</b> × <b>Expired / Logged Out</b>\n`
        );
      } else {
        const liveOut = await verifySwiggySessionLive(acc).catch(() => null);
        if (liveOut?.valid) {
          acc.isLoggedIn = true;
          if (liveOut.liveTid) acc.tid = liveOut.liveTid;
          if (liveOut.token) acc.token = liveOut.token;
          reportItems.push(
            `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• ◈ <b>Session:</b> ● <b>Active (${liveOut.transport || 'Verified'})</b>\n`
          );
        } else if (orderOut?.status === 202 || orderOut?.status === 403) {
          reportItems.push(
            `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• ◈ <b>Session:</b> ⚠️ <b>CloudFront WAF Challenge (Session preserved)</b>\n`
          );
        } else {
          acc.isLoggedIn = false;
          acc.sessionExpired = true;
          reportItems.push(
            `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
            `• ◈ <b>Session:</b> × <b>Expired / Logged Out</b>\n`
          );
        }
      }
    } catch (netErr) {
      reportItems.push(
        `<b>${i + 1}. ◉ ${escapeHtml(accName)}</b> (<code>${phone}</code>)\n` +
        `• ◈ <b>Session:</b> ! Network Timeout (${escapeHtml(netErr.message)})\n`
      );
    }
  }

  saveDb(db);

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}

  const finalReport =
    `<blockquote>↻ <b>SWIGGY ACCOUNTS AUDIT & REFRESH</b></blockquote>\n\n` +
    reportItems.join('\n');

  await sendSafeHtml(ctx, finalReport, Markup.inlineKeyboard([
    [
      Markup.button.callback('↻ Refresh Again', 'boss_refresh_all_accounts'),
      Markup.button.callback('↑ Export Accounts', 'boss_export_picker')
    ],
    [
      Markup.button.callback('× Delete / Clean Dead', 'boss_delete_picker'),
      Markup.button.callback('◉ View Accounts', 'boss_view_accounts')
    ]
  ]));
});

// Dynamic Session JSON Import Target Selector
bot.action(/^boss_apply_import_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetKey = ctx.match[1];
  const state = userWaitState[ctx.from.id];
  if (!state?.pendingJson) return ctx.answerCbQuery('No pending JSON').catch(() => {});

  if (targetKey === 'new') {
    userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name_for_json', pendingJson: state.pendingJson };
    await ctx.reply(
      `+ <b>Enter Name for New Account:</b>\n(e.g. <code>Bhai</code>, <code>Chacha</code>, <code>Office</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' }
      }
    );
    return;
  }

  await ctx.answerCbQuery('Importing & claiming offers... !').catch(() => {});
  await handleProcessJsonLogin(ctx, state.pendingJson, ctx.from.id, targetKey, null);
});

// Dynamic Fast OTP Target Selector (supports `acc_9935123518` with underscores!)
bot.action(/^boss_fast_otp_(.+)_(\d{10})$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetAcc = ctx.match[1];
  const phone = ctx.match[2];

  if (targetAcc === 'new') {
    userWaitState[ctx.from.id] = { action: 'waiting_new_acc_name_for_fast_otp', phone };
    await ctx.reply(
      `+ <b>Enter Name for New Account (${phone}):</b>\n(e.g. <code>Bhai</code>, <code>Chacha</code>):`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' }
      }
    );
    return;
  }

  await ctx.answerCbQuery(`Sending OTP to ${phone}... !`).catch(() => {});
  const db = getDb();
  const accName = db.config.accounts?.[targetAcc]?.name || targetAcc;

  const result = await requestSwiggyOtpViaBridge(ctx.from.id, phone, targetAcc, accName);
  if (result.success) {
    userWaitState[ctx.from.id] = {
      action: 'waiting_swiggy_otp_bridge',
      targetAcc,
      phone,
      name: accName,
      isNewUser: Boolean(result.isNewUser)
    };
    await ctx.reply(
      `☎ <b>OTP Sent</b>\n☎ <code>${phone}</code>\n\n› <i>Enter OTP:</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('↻ Re-enter OTP', `prompt_reenter_otp_${phone}`),
            Markup.button.callback('✉ Resend OTP', `resend_otp_${phone}`)
          ],
          [
            Markup.button.callback('☎ Another Number', 'send_to_another_number'),
            Markup.button.callback('⌂ Main Menu', 'boss_panel_home')
          ],
          [
            Markup.button.callback('× Close', 'close_menu')
          ]
        ])
      }
    );
  } else {
    const errCard = formatOtpSendErrorCard(phone, result);
    await ctx.reply(errCard.text, {
      parse_mode: 'HTML',
      ...errCard.keyboard
    });
  }
});

// Amount Setting Button
bot.action(/^boss_set_amount_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_amount', orderId };

  await ctx.reply(
    `₹ <b>Set Amount for Order #${orderId}:</b>\n\n` +
    `Current: <b>₹${order.finalPayable || 350}</b>\n\n` +
    `<i>Naya amount chat me likh kar bhejein (jaise 450):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter amount in ₹...' }
    }
  );
});

// Boss Manual Coupon Code Setting Button
bot.action(/^boss_set_coupon_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_set_coupon', orderId };

  await ctx.reply(
    `# <b>Apply Coupon Code for Order #${orderId}:</b>\n\n` +
    `Current Applied: <b>${order.couponCode ? order.couponCode + ' (−₹' + (order.discountAmount || 0) + ')' : 'None'}</b>\n\n` +
    `<i>Swiggy coupon code likh kar bhejein (jaise: <b>WELCOME50</b>, <b>TRYNEW</b>, <b>SWIGGY50</b>, <b>MIDNIGHT</b>, ya <b>REMOVE</b>):</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter coupon code (e.g. WELCOME50)...' }
    }
  );
});

// Boss Refresh Cart & Offers Button
bot.action(/^boss_refresh_cart_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery('Re-fetching cart & best coupons with Swiggy... ◷').catch(() => {});
  await ctx.reply(`◷ <i>Re-inspecting Swiggy cart and checking best offers for Order #${orderId}...</i>`, { parse_mode: 'HTML' });
  triggerBackgroundCartFetch(orderId).catch(err => console.error('[RefreshCart] error:', err.message));
});

// Phase 3 -> Phase 4: User accepts the order amount -> Automatically send authentic UPI QR!
bot.action(/^user_accept_amount_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  // Security check: Only the customer who owns this order (or boss) can accept
  if (Number(order.userId) !== Number(ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }

  // State check: Order must not be completed or cancelled
  if (order.status === 'COMPLETED' || order.status === 'CANCELLED') {
    return ctx.answerCbQuery(`Order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.amountAccepted = true;
  order.status = 'AMOUNT_CONFIRMED';
  order.qrSent = true;
  saveDb(db);

  await ctx.answerCbQuery('Amount Accepted! Generating UPI QR... ₹').catch(() => {});

  // 🚫 Boss (30-10-2026): order ka QR SIRF Swiggy ka — boss ki UPI se nahi.
  const swiggyPayUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
  if (!swiggyPayUri) {
    return ctx.reply(
      `⚠️ <b>QR nahi bhej sakta — Swiggy ne payment QR nahi diya.</b>\n\n` +
      `<i>"Dobara try" dabaiye — naya QR banega. Boss ki personal UPI se order ka QR nahi banta (paisa Swiggy tak nahi pahunchta).</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Dobara try', callback_data: `user_retry_qr_${order.id}`, style: 'success' }],
            [{ text: '₹ Swiggy Payment Page', url: 'https://www.swiggy.com/payments' }]
          ]
        }
      }
    ).catch(() => {});
  }
  const upiUri = sanitizeUpiUriForQr(swiggyPayUri);
  let qrBuf = null;
  try {
    qrBuf = await generateNamedUpiQrPngBuffer({
      upiUri,
      senderName: order.userName || order.restaurantName || 'Swiggy',
      restaurantName: order.restaurantName || 'Swiggy',
      amount: amt,
      orderId: order.id
    });
  } catch (err) {
    console.error('Failed to generate QR buffer:', err.message);
  }

  if (qrBuf && (order.userChatId || order.userId)) {
    try {
      const targetChat = order.userChatId || order.userId;
      await bot.telegram.sendPhoto(targetChat, { source: qrBuf }, {
        caption: `₹ <b>Payment QR Code (#${order.id})</b>\n\n` +
          `₹ <b>Payable Amount:</b> <b>₹${amt}</b>\n` +
          `⌖ <b>Payee:</b> <code>${escapeHtml(payeeVpaFromUpiUri(upiUri) || 'Swiggy')}</code>\n\n` +
          `<i>Kisi bhi UPI app (GPay, PhonePe, Paytm) se scan karke ₹${amt} pay karein. Payment ke baad neeche "Check payment status" button dabayein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Check payment status', `user_paid_status_${order.id}`)],
          [Markup.button.callback('● Cancel Order', `action_cancel_order_confirm_${order.id}`)]
        ])
      });
    } catch (e) {
      console.error('Failed to send QR photo to user:', e.message);
    }
  }

  // Update in-place on User & Boss single cards
  await updateOrderCards(order);
});

// Screen 3 -> Screen 4: Generate QR Button
bot.action(/^boss_generate_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!order.finalPayable || Number(order.finalPayable) <= 0) {
    if (order.subtotal && Number(order.subtotal) > 0) {
      order.finalPayable = Math.round(order.subtotal);
    } else {
      return ctx.answerCbQuery('! Pehle Amount set karein (Amount must be > 0)!', { show_alert: true }).catch(() => {});
    }
  }

  order.amountAccepted = true;
  if (order.status === 'PENDING') {
    order.status = 'ACCEPTED';
    order.acceptedAt = new Date().toISOString();
  }

  await ctx.answerCbQuery('Generating genuine payment QR... !').catch(() => {});

  const payable = order.finalPayable || order.subtotal || 0;
  // Boss (30-10-2026): boss ki UPI ko order ka QR nahi banate.
  const payeeName = 'SWIGGY';

  const userButtons = [
    [Markup.button.url('● Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    userButtons.push([Markup.button.url('● Open Swiggy Cart / Items', order.cart)]);
  }

  const bossButtons = [
    [Markup.button.url('Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('Swiggy Cart / Group Order', order.cart)]);
  }

  let qrDelivered = false;

  // Case 1: Custom real Swiggy QR screenshot uploaded by Boss
  if (order.customQrFileId) {
    try {
      await bot.telegram.sendPhoto(order.userId, order.customQrFileId, {
        caption: `● <b>Swiggy Genuine Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n☎ <b>Payment Instructions:</b>\n` +
          `1. Kisi bhi UPI App (PhonePe, Google Pay, Paytm, BHIM) se yeh QR scan karein.\n` +
          `2. Exact <b>₹${payable}</b> pay karein.\n` +
          `3. Payment ke baad niche <b>[ Check payment status ]</b> dabayein!`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      qrDelivered = true;
    } catch (err) {
      console.error('Failed to send genuine QR to user:', err.message);
    }

    try {
      const userProfileUrl = `tg://user?id=${order.userId}`;
      await ctx.replyWithPhoto(order.customQrFileId, {
        caption: `! <b>GENUINE PAYMENT QR DELIVERED!</b>\n\n` +
          `⌖ <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `◉ <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
          `◎ <b>Swiggy Checkout:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
          `<i>Genuine QR image successfully delivered to User and Boss.</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });
    } catch (err) {
      console.error('Failed to send genuine QR to boss:', err.message);
    }
  } else {
    // Case 2: Swiggy ka apna payment intent — usi se QR (boss ki UPI se NAHI).
    // Boss (30-10-2026): personal UPI ka QR "Swiggy order payment" ban ke nahi
    // jayega; paisa Swiggy tak pahunchna chahiye.
    const swiggyDirectUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
    if (!swiggyDirectUri) {
      await ctx.reply(
        `⚠️ <b>QR nahi bana — Swiggy ne payment QR nahi diya.</b>\n\n` +
        `<i>Boss ki personal UPI se order ka QR nahi banta (paisa Swiggy tak nahi pahunchta, order cancel ho jata hai).</i>\n` +
        `Swiggy checkout se asli QR screenshot bhejein: <code>/setupi</code> nahi — niche wala button dabaiye.`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '▣ Upload Swiggy QR', callback_data: `boss_upload_custom_qr_${orderId}`, style: 'success' }]] }
        }
      ).catch(() => {});
      return;
    }
    try {
      const upiUri = sanitizeUpiUriForQr(swiggyDirectUri);
      const qrBuffer = await generateNamedUpiQrPngBuffer({
        upiUri,
        senderName: order.userName || payeeName,
        restaurantName: payeeName,
        amount: payable,
        orderId
      });

      await bot.telegram.sendPhoto(order.userId, { source: qrBuffer }, {
        caption: safeTelegramCaption(
          `● <b>Swiggy Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Food Order', 120))}\n` +
          `₹ <b>Total Payable Amount:</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n☎ <b>Payment Instructions:</b>\n` +
          `1. Kisi bhi UPI app (Google Pay / PhonePe / Paytm / BHIM) se QR scan karein.\n` +
          `2. Exact <b>₹${payable}</b> pay karein.\n` +
          `3. Payment ke baad niche <b>[ Check payment status ]</b> dabayein:`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });

      const userProfileUrl = `tg://user?id=${order.userId}`;
      await ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: safeTelegramCaption(
          `! <b>AUTHENTIC UPI PAYMENT QR DELIVERED!</b>\n\n` +
          `⌖ <b>Order #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
          `◉ <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(truncateDisplayField(order.userName, 90))}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
          `₹ <b>Receiving UPI ID:</b> <code>${escapeHtml(payeeVpaFromUpiUri(upiUri) || 'Swiggy')}</code>\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Order', 120))}\n\n` +
          `<i>User ke chat me scannable QR bhej diya gaya hai! Payment hote hi user confirm karega.</i>`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });

      qrDelivered = true;
    } catch (qrErr) {
      console.error('Failed to generate UPI QR:', qrErr.message);
      await ctx.reply(`× QR Generation Error: ${qrErr.message}`);
      return;
    }
  }

  if (qrDelivered) {
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);
  }
});

// Boss Get QR button (Card 3 in FigJam)
bot.action(/^boss_get_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Fetching genuine payment info... ▣').catch(() => {});
  const payable = order.finalPayable || order.subtotal || 0;

  const bossButtons = [
    [Markup.button.url('Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];
  if (order.cart && order.cart.startsWith('http')) {
    bossButtons.unshift([Markup.button.url('Swiggy Cart / Group Order', order.cart)]);
  }

  if (order.customQrFileId) {
    await ctx.replyWithPhoto(order.customQrFileId, {
      caption: `▣ <b>GENUINE PAYMENT QR FOR REQUEST #${orderId}</b>\n\n` +
        `₹ <b>Amount:</b> <b>₹${payable}</b>\n` +
        `◎ <b>Swiggy Payment:</b> <code>https://www.swiggy.com/payments</code>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    });
  } else {
    try {
      // Boss (30-10-2026): order ka QR SIRF Swiggy ka.
      const swiggyReqUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
      if (!swiggyReqUri) {
        return ctx.reply(
          `⚠️ <b>QR nahi bana — Swiggy ne payment QR nahi diya.</b>\n\n<i>"Dobara try" dabaiye. Boss ki UPI se order ka QR nahi banega.</i>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Dobara try', callback_data: `user_retry_qr_${orderId}`, style: 'success' }]] } }
        ).catch(() => {});
      }
      const payeeName = 'SWIGGY';
      const upiUri = sanitizeUpiUriForQr(swiggyReqUri);
      const qrBuffer = await generateNamedUpiQrPngBuffer({
        upiUri,
        senderName: order.userName || payeeName,
        restaurantName: payeeName,
        amount: payable,
        orderId
      });
      await ctx.replyWithPhoto({ source: qrBuffer }, {
        caption: safeTelegramCaption(
          `▣ <b>AUTHENTIC UPI PAYMENT QR FOR REQUEST #${orderId}</b>\n\n` +
          `₹ <b>Amount:</b> <b>₹${payable}</b>\n` +
          `₹ <b>Receiving UPI:</b> <code>${escapeHtml(payeeVpaFromUpiUri(upiUri) || 'Swiggy')}</code>\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(truncateDisplayField(order.restaurantName || 'Swiggy Order', 120))}\n\n` +
          `<i>Kisi bhi UPI app (Google Pay / PhonePe / Paytm / BHIM) se scan karke payment ho jayega!</i>`,
          1000
        ),
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(bossButtons)
      });
    } catch (e) {
      await ctx.reply(`× QR Generation Error: ${e.message}`);
    }
  }
});

// Boss Upload Custom Swiggy QR Prompt
bot.action([/^boss_upload_custom_qr_(.+)$/, /^boss_prompt_send_qr_(.+)$/, /^boss_send_payment_qr_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});

  // If genuine QR is already captured from Swiggy checkout, send immediately to user!
  if (order.genuineQrBuffer || order.customQrFileId) {
    await sendPaymentQrToUser(order);
    return ctx.reply(`✓ <b>Genuine Swiggy Payment QR successfully sent to Customer for Order #${orderId}!</b>`, { parse_mode: 'HTML' });
  }

  userWaitState[ctx.from.id] = { action: 'waiting_custom_qr_photo', orderId };
  await ctx.reply(
    `▣ <b>Send Genuine Swiggy Payment QR (Order #${orderId}):</b>\n\n` +
    `Swiggy checkout/payment screen se genuine payment QR ka screenshot image ke roop me chat me send karein:\n\n` +
    `› Yeh photo seedha customer ko deliver ho jayegi aur customer scan karke Swiggy ko pay kar sakega!`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '• Send QR screenshot here...'
      }
    }
  );
});

// Boss Live Swiggy Payment Screen Capture
bot.action(/^boss_live_pay_screen_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config?.accounts?.[accKey];
  if (!acc?.cookies) {
    return ctx.answerCbQuery('Selected account does not have active cookies!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Capturing live Swiggy payment screen... ▣').catch(() => {});
  const statusMsg = await ctx.reply('◷ <i>Opening Swiggy checkout & capturing live payment screen with cookies...</i>', { parse_mode: 'HTML' });

  const buf = await captureSwiggyPaymentScreenshot(acc.cookies);
  if (buf) {
    await ctx.replyWithPhoto({ source: buf }, {
      caption: `▣ <b>Live Swiggy Checkout / Payment Screen (Order #${orderId})</b>\n\n` +
        `◉ Account: <b>${acc.name || accKey}</b>\n` +
        `₹ Payable: <b>₹${order.finalPayable || 0}</b>\n\n` +
        `<i>Aap is screenshot ko Ammi ko bhej sakte hain ya payment page par jaakar pay kar sakte hain.</i>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
        [Markup.button.callback('↑ Send this Screen to Ammi', `boss_forward_live_screen_${orderId}`)]
      ])
    });
  } else {
    await ctx.reply('! Could not capture live payment screen. Swiggy session might need fresh cookies.');
  }

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}
});

// Boss Forward Live Screenshot to User / Ammi
bot.action(/^boss_forward_live_screen_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  const accKey = order.selectedAccount || getActiveOrderAccountKey(db);
  const acc = db.config?.accounts?.[accKey];
  if (!acc?.cookies) {
    return ctx.answerCbQuery('No cookies available!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Sending screen to Ammi... ↑').catch(() => {});
  const buf = await captureSwiggyPaymentScreenshot(acc.cookies);
  if (buf) {
    const payable = order.finalPayable || 350;
    try {
      await bot.telegram.sendPhoto(order.userId, { source: buf }, {
        caption: `● <b>Swiggy Live Payment Screen (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne Swiggy payment screen bhej di hai! Payment karein ya payment status check karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
          ...(order.cart?.startsWith('http') ? [[Markup.button.url('▤ Open Swiggy Cart / Items', order.cart)]] : []),
          [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
        ])
      });
      await ctx.reply(`✓ <b>Live Swiggy payment screen deliver ho gaya Ammi/User ko!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to send photo to user: ${err.message}`);
    }
  } else {
    await ctx.reply('! Failed to capture screenshot.');
  }
});

// Copy Cart fallback handlers
bot.action(/^(?:boss_copy_cart_|boss_copy_cart_link_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order || !order.cart) return ctx.answerCbQuery('Cart link not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Cart link copied!').catch(() => {});
  await ctx.reply(`● <b>Cart Link (#${orderId}):</b>\n<code>${escapeHtml(order.cart)}</code>`, { parse_mode: 'HTML' });
});

// Copy Address fallback handlers
bot.action(/^(?:boss_copy_addr_|boss_copy_addr_link_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders[orderId];
  if (!order || !order.address) return ctx.answerCbQuery('Address link not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Address link copied!').catch(() => {});
  await ctx.reply(`● <b>Address Link (#${orderId}):</b>\n<code>${escapeHtml(order.address)}</code>`, { parse_mode: 'HTML' });
});

// Cancel Order button: Prompt confirmation (Card Row 2 in FigJam)
bot.action(/^boss_prompt_cancel_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (hasPossibleSwiggyPlacement(order)) {
    return ctx.answerCbQuery('Order Swiggy par ho sakta hai. Original Swiggy account me check/cancel karein; bot se cancel nahi hua.', { show_alert: true }).catch(() => {});
  }


  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  const userProfileUrl = `tg://user?id=${order.userId}`;
  const text = `! <b>Kya aap waqai Order #${orderId} cancel karna chahte hain?</b>\n\n` +
    `◉ <b>Customer:</b> <a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> (TG ID: <a href="${userProfileUrl}">${order.userId}</a>)\n` +
    `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
    `₹ <b>Amount:</b> ₹${order.finalPayable || 0}\n\n` +
    `<i>Niche confirmation select karein:</i>`;

  const buttons = [
    [
      Markup.button.callback('Are you sure (Cancel)', `boss_confirm_cancel_${orderId}`),
      Markup.button.callback('Keep Order', `boss_keep_order_${orderId}`)
    ]
  ];

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }
});

// Boss Keep Order (cancel aborted)
bot.action(/^boss_keep_order_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Order active hai ●').catch(() => {});
  const card = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
  } catch (e) {
    await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard });
  }
});

// Boss Confirm Cancel Order (Performs cancellation and deletes message cards)
bot.action(/^(?:boss_confirm_cancel_|boss_cancel_order_)(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (hasPossibleSwiggyPlacement(order)) {
    return ctx.answerCbQuery('Order Swiggy par ho sakta hai. Original Swiggy account me check/cancel karein; bot se cancel nahi hua.', { show_alert: true }).catch(() => {});
  }


  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'CANCELLED';
  order.cancelledAt = new Date().toISOString();
  saveDb(db);
  try { stopOrderTrackingAuto(order.id); } catch {}
  await ctx.answerCbQuery('Order Cancelled ●').catch(() => {});

  // 1. Delete message from current chat
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // 2. Delete order card messages from all chats
  await deleteOrderMessages(order);

  // 3. Confirm to Boss with direct View Cancelled Orders button
  await ctx.reply(
    `× <b>ORDER CANCELLED (#${orderId})</b>\n\n` +
    `Order #${orderId} cancel kar diya gaya aur card delete ho gaya.\n\n` +
    `Sabhi cancelled orders dekhne ke liye neeche button dabayein:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('× View Cancelled Orders', 'boss_view_cancelled_orders')]
      ])
    }
  );

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `× <b>Order #${orderId} cancel kar diya gaya hai.</b>\n\nAap dobara naya link bhej sakte hain.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}
});

// Remind Fee button (Card Row 2 in FigJam)
bot.action(/^boss_remind_fee_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Reminder sent to parent! •').catch(() => {});
  const payable = order.finalPayable || order.subtotal || 350;

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `♥ <b>Khushamdeed! Beta ne Swiggy order amount ₹${payable} verify kar diya hai.</b>\n\n` +
      `Kripya screen par <b>[ ✓ Accept Order (Amount Okay) ]</b> dabayein taaki beta payment QR bhej sake!`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {}
});

// Common handler for payment verification and real tracking extraction
/** Render the per-account scan diagnostics for an all-IDs scan: how many
 *  accounts actually returned a list (OK, no order) vs which failed and why,
 *  so NOT_FOUND never hides "that account was never checked". */
async function handleConfirmOrderPaid(ctx, orderId, _confirmedBy) {
  // Telegram expires callback answers after ~10s, but payment verification +
  // all-IDs tracking scan takes longer → a late answerCbQuery ALWAYS 400s with
  // "query is too old and response timeout expired". Answer ONCE, instantly
  // (toast), then deliver the full result as a chat message.
  await ctx.answerCbQuery('Verifying payment + checking tracking…').catch(() => {});
  const result = await checkOrderPaidStatusOnly(orderId);
  try {
    const ord = getDb().orders?.[orderId];
    const link = ord ? getStoredSwiggyTrackingUrl(ord) : '';
    const otp = String(ord?.deliveryOtp || '');
    await ctx.reply(
      (result?.message ? `◉ ${escapeHtml(result.message)}\n` : '') +
      (link ? `🔗 <b>Tracking link:</b>\n<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>\n` : '') +
      (otp ? `🔑 <b>Delivery OTP:</b> <code>${escapeHtml(otp)}</code>\n` : '') +
      `<i>Payment final hai — tracking auto-retry chalta rahega, link aate hi yahan aayega.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } catch {}
}

bot.action(/^user_confirm_order_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }
  await handleConfirmOrderPaid(ctx, orderId, 'User');
});

bot.action(/^user_resend_qr_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return ctx.answerCbQuery('No payment QR is available for a closed order.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Resending payment details...').catch(() => {});
  // Same rule: only a still-valid QR is resent; otherwise a fresh one is made.
  const legacyReuse = shouldReusePendingQr(order, { accountPhone: order.orderAccount || '' });
  if (legacyReuse.reuse || order.customQrFileId) {
    await sendPaymentQrToUser(order);
    return;
  }
  {
    const markDb = getDb();
    if (markDb.orders?.[order.id]) {
      markDb.orders[order.id].qrInvalidatedAt = new Date().toISOString();
      markDb.orders[order.id].qrInvalidReason = legacyReuse.reason;
      saveDb(markDb);
    }
  }
  try {
    await executeRealQrGenerationForOrder({
      telegram: bot.telegram,
      chatId: String(ctx.from.id),
      orderId: order.id,
      formatOrderBodyFn: formatUserOrderCardText,
      forceNewQr: true
    });
  } catch (error) {
    await ctx.reply(
      `× <b>Naya QR nahi ban paya:</b> ${escapeHtml(error.message)}\n<i>Purana QR dobara nahi bheja gaya — wo valid nahi tha.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

bot.action(/^boss_confirm_paid_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  await handleConfirmOrderPaid(ctx, orderId, 'Boss');
});

// Universal Extract Now — any user pastes Order ID and taps this button → scan All IDs
bot.action(/^extract_now_([A-Za-z0-9_-]+)$/, async (ctx) => {
  if (_isScanRateLimited(ctx.from.id, 3, 60_000)) {
    return ctx.answerCbQuery('⏳ Thoda slow — 1 minute me max 3 scans! Thodi der baad try karein.', { show_alert: true }).catch(()=>{});
  }
  const q = String(ctx.match[1] || '').trim();
  await ctx.answerCbQuery('Extracting — scanning Swiggy IDs…').catch(() => {});

  const db2 = getDb();
  let order = db2.orders?.[q] || db2.orders?.[q.toLowerCase()] || db2.orders?.[q.toUpperCase()];
  if (!order) {
    const qL = q.toLowerCase();
    for (const oo of Object.values(db2.orders || {})) {
      if (String(oo.id || '').toLowerCase() === qL || String(oo.swiggyOrderId || '') === q || String(oo.pendingSwiggyOrderId || '') === q) {
        order = oo;
        break;
      }
    }
  }

  const isNumericSwiggyId = /^\d{10,20}$/.test(q);
  if (!order && !isNumericSwiggyId) {
    await ctx.reply(`❌ Order <code>${escapeHtml(q)}</code> not found.\n\n<i>Bot koi false order id nahi banata — sirf real Swiggy order id (numeric) scan hota hai.</i>`, { parse_mode: 'HTML' });
    return;
  }

  // A numeric Swiggy id that is not in the bot DB is scanned as a TRANSIENT
  // reference. It is saved only if Swiggy confirms the order exists.
  if (!order) {
    order = {
      id: q,
      swiggyOrderId: q,
      pendingSwiggyOrderId: q,
      restaurantName: 'Swiggy Order',
      status: 'UNVERIFIED',
      addressDetails: {},
      createdAt: new Date().toISOString(),
      userId: String(ctx.from.id),
      fwdSenderUserId: String(ctx.from.id),
      userName: ctx.from?.first_name || 'Customer',
      fwdSenderName: ctx.from?.first_name || 'Customer',
      selectedAccount: '',
      trackingLink: '',
      trackingLinkSource: '',
      deliveryOtp: '',
      liveOrderStatus: '',
      isSwiggyIdLookup: true
    };
  }

  const statusMsg = await ctx.reply(
    `⏳ <i>Scanning ${Object.keys(db2.config?.accounts || {}).length} Swiggy IDs for <code>${escapeHtml(q)}</code>…</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => null);

  try {
    const result = await ensureOrderTracking(order, { force: true, budgetMs: 20000, deep: true });
    if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }

    if (result?.status === 'WAF_COOLDOWN') {
      const min = Math.max(1, Math.ceil((result.cooldownMs || 0) / 60000));
      await ctx.reply(
        `⏳ <b>Swiggy WAF cooldown — ${min} min bane.</b>\n\n<i>Bot ne saare scans ${min} min ke liye pause kar diye taaki block thanda ho jaye (zyada retry se block aur der tak rehta hai). ${min} min baad <code>${escapeHtml(q)}</code> dobara bhej dena — auto-scan bhi khud resume ho jayega.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const fresh = getDb().orders?.[order.id] || order;
    const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
    const swiggyId = swiggyOrderIdOf(fresh) || q;
    const phone = placedFromPhoneOf(fresh, getDb());

    if (!result?.hasOrder && !trackingUrl) {
      await ctx.reply(
        `❌ <b>Swiggy order <code>${escapeHtml(q)}</code> kisi bhi logged-in ID par nahi mila.</b>\n\n` +
        `▪ Scanned: <b>${Number(result?.scanned) || 0}</b> IDs${result?.status === 'TIMEOUT' ? ' (time out)' : ''}\n` +
        scanFailuresLine(result) +
        `▪ <b>Order kisi dusre Swiggy account par hoga</b> — jis account se order hua usko is bot me login karo (<b>My Accounts</b>), phir dobara id bhejo.\n` +
        `<i>Order id bhi verify karo (numeric, 12–18 digits) — Swiggy app: Profile → My Orders. Bot koi false tracking link nahi banata.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Swiggy confirmed the order exists — persist it as a genuine external order.
    const saveDbNow = getDb();
    const rec = saveDbNow.orders?.[order.id] || fresh;
    if (!saveDbNow.orders?.[order.id]) {
      rec.isExternalOrder = true;
      rec.isSwiggyIdLookup = true;
      saveDbNow.orders[rec.id] = rec;
    }
    if (rec.status !== 'COMPLETED') {
      rec.status = 'COMPLETED';
      rec.cardStage = 'PAID_CONFIRMED';
      rec.completedAt = rec.completedAt || new Date().toISOString();
    }
    saveDb(saveDbNow);

    const rawLiveStatusNow = String(rec.liveOrderStatus || result?.orderStatus || '');
    const liveStatusNow = normalizeSwiggyLiveOrderStatus(rawLiveStatusNow) || rawLiveStatusNow;
    const isCancelledNow = /cancel|refus|return/i.test(liveStatusNow);
    const isDeliveredNow = /deliv/i.test(liveStatusNow);
    if (trackingUrl) {
      await ctx.reply(
        `✅ <b>Tracking found</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        (liveStatusNow ? `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow)}</code>\n` : '') +
        `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open Swiggy tracking</a>` +
        (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
        (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy tracking', trackingUrl)]])
        }
      );
    } else if (isCancelledNow) {
      await ctx.reply(
        `✅ <b>Order mil gaya</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow)}</code>\n\n` +
        `<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`,
        { parse_mode: 'HTML' }
      );
    } else if (isDeliveredNow) {
      const deliveredUrl = buildSignedOrderTrackUrl(swiggyId || rec.id);
      await ctx.reply(
        `✅ <b>Tracking link ready</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow)}</code>` +
        (deliveredUrl ? `\n▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredUrl)}">Open order tracking</a>` : '') +
        (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
        (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...Markup.inlineKeyboard([
            ...(deliveredUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredUrl)]] : []),
            [Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]
          ])
        }
      );
    } else {
      await ctx.reply(
        `✅ <b>Order mil gaya</b>\n` +
        `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
        `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
        `▪ <b>Status:</b> <code>${escapeHtml(liveStatusNow || 'Order Confirmed')}</code>\n\n` +
        `<i>Swiggy ne share link abhi publish nahi kiya — bot background me retry karega aur link aate hi bhej dega.</i>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]]) }
      );
      startOrderTrackingAuto(rec.id, { force: true, budgetMs: 12000 });
    }
  } catch (e) {
    if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }
    await ctx.reply(`❌ ${escapeHtml(String(e?.message || e))}`, { parse_mode: 'HTML' });
  }
});

// View Family Accounts
bot.action('boss_extract_tracking_prompt', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized');
  await ctx.answerCbQuery().catch(()=>{});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_extract_tracking' };
  await ctx.reply('🔗 <b>Extract Delivery Link — All IDs scan</b>\nSend the <b>Order ID</b> (e.g. <code>FWD9670</code>) or Swiggy Order ID. I will check every logged-in Swiggy ID for its tracking link.', { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Enter Order ID' } });
});

bot.action('boss_view_accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await showFamilyAccounts(ctx);
});

bot.hears('◉ Family Accounts', async (ctx) => {
  if (!isBoss(ctx.from.id)) {
    // Customers have no access to the vault; give them their own order status
    // instead of a silent tap.
    const userId = ctx.from.id;
    const draft = getDraft(userId);
    const screen = getUserScreen(userId, ctx.from);
    return renderUserCard(ctx, userId, { notice: draft.cart || draft.address ? '🟠 Aapka draft ready hai' : '🟠 Family accounts Boss ke paas hain' });
  }
  await showFamilyAccounts(ctx);
});

export async function showFamilyAccounts(ctx) {
  const db = getDb();
  const accounts = db.config.accounts || {};
  const activeKey = db.config.activeOrderAccount;
  const entries = Object.entries(accounts);
  const liveCount = entries.filter(([, a]) => isAccountLoggedInSession(a)).length;
  const deadCount = entries.length - liveCount;

  // Collapsed one-liner per account; full truth + Copy JSON lives behind the tap.
  const compact = compactAccountListText(accounts, {
    activeKey,
    header: `◉ <b>CONNECTED SWIGGY ACCOUNTS (${liveCount} Active / ${entries.length} Total):</b>`
  });
  let text = compact.text;
  if (entries.length > 0) {
    text += `\n<i>↓ Kisi bhi account par tap karein — orders LIVE check, offer CLAIMED/NEW, aur Copy JSON.</i>`;
  }

  const buttons = [];

  for (let i = 0; i < entries.length; i += 2) {
    const row = [];
    const [k1, a1] = entries[i];
    const live1 = isAccountLoggedInSession(a1);
    const icon1 = live1 ? (k1 === activeKey ? '★' : '●') : (a1.sessionExpired ? '⚠️' : '○');
    const t1 = liveOrderTruth(a1);
    const ordBadge1 = t1.totalOrders === null ? '[ord?]' : (t1.totalOrders === 0 ? '[0 ord✓]' : `[${t1.totalOrders} ord✓]`);
    const label1 = `${icon1} ${a1.phone || a1.name || k1} ${ordBadge1}`.trim();
    row.push({ text: label1, callback_data: `acc_view_detail_${k1}`, style: live1 ? 'success' : 'primary' });
    if (entries[i + 1]) {
      const [k2, a2] = entries[i + 1];
      const live2 = isAccountLoggedInSession(a2);
      const icon2 = live2 ? (k2 === activeKey ? '★' : '●') : (a2.sessionExpired ? '⚠️' : '○');
      const t2 = liveOrderTruth(a2);
      const ordBadge2 = t2.totalOrders === null ? '[ord?]' : (t2.totalOrders === 0 ? '[0 ord✓]' : `[${t2.totalOrders} ord✓]`);
      const label2 = `${icon2} ${a2.phone || a2.name || k2} ${ordBadge2}`.trim();
      row.push({ text: label2, callback_data: `acc_view_detail_${k2}`, style: live2 ? 'success' : 'primary' });
    }
    buttons.push(row);
  }

  buttons.push([
    { text: '▣ Claim ₹50 Off Offers (All Active)', callback_data: 'boss_claim_all_event_offers', style: 'success' }
  ]);
  buttons.push([
    { text: 'Login with Number', callback_data: 'boss_login_with_number', style: 'primary' },
    { text: 'Login with JSON', callback_data: 'boss_login_with_json', style: 'primary' }
  ]);
  buttons.push([
    { text: 'Refresh All Accounts', callback_data: 'boss_refresh_all_accounts', style: 'primary' },
    { text: 'Export Session JSON', callback_data: 'boss_export_picker', style: 'primary' }
  ]);
  buttons.push([
    { text: '⇧ Export & Logout (1+ Orders)', callback_data: 'boss_export_logout_picker', style: 'success' }
  ]);
  buttons.push([
    { text: '! Logout All Accounts', callback_data: 'boss_logout_all_confirm', style: 'danger' },
    { text: '↗ Logout Single Account', callback_data: 'boss_logout_picker', style: 'danger' }
  ]);
  buttons.push([
    { text: 'Delete Account', callback_data: 'boss_delete_picker', style: 'danger' }
  ]);
  if (deadCount > 0) {
    buttons.push([
      { text: `× Remove Logged-Out Accounts (${deadCount})`, callback_data: 'boss_clean_dead_accounts', style: 'danger' }
    ]);
  }
  buttons.push([
    { text: 'Switch Active Account', callback_data: 'boss_switch_active_picker', style: 'primary' },
    { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      return;
    } catch (e) {}
  }
  await sendSafeHtml(ctx, text, { reply_markup: { inline_keyboard: buttons } });
}

// Boss Action: Claim ₹50 Off Offers in All Logged-in Accounts
async function runBossEventOffersClaim(ctx, chosenOfferValue = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized').catch(() => {});
    return;
  }
  const db = getDb();
  const accounts = db.config.accounts || {};
  const activeEntries = Object.entries(accounts).filter(([, a]) => a.isLoggedIn && (a.cookies || a.tid || a.token));
  const skippedCount = Object.keys(accounts).length - activeEntries.length;

  if (ctx.callbackQuery) {
    const label = chosenOfferValue ? (EVENT_OFFER_OPTIONS[chosenOfferValue]?.shortLabel || `Option #${chosenOfferValue}`) : 'All Active Accounts';
    await ctx.answerCbQuery(`Locking ${label} across today + next 14 days... ›`).catch(() => {});
  }

  if (activeEntries.length === 0) {
    return ctx.reply('! <b>Koi bhi Active Logged-In account nahi mila!</b>\n\nPehle Number ya JSON se account login karein.', {
      parse_mode: 'HTML',
      ...getBossPanelKeyboard()
    });
  }

  const effectiveVal = [1, 2, 3, 4].includes(Number(chosenOfferValue)) ? Number(chosenOfferValue) : null;
  const headerMeta = EVENT_OFFER_OPTIONS[effectiveVal || 1] || EVENT_OFFER_OPTIONS[1];

  const waitMsg = await ctx.reply(
    `◷ <b>Swiggy Breakfast &amp; Late Night 15-Day Pre-Book Running...</b>\n\n` +
    `▣ <b>Selected Reward:</b> ${escapeHtml(headerMeta.fullLabel)}\n` +
    `• <b>Breakfast Slot:</b> 7:00 AM – 11:00 AM (cutoff 5:00 AM IST)\n` +
    `◷ <b>Late Night Slot:</b> 9:00 PM – 6:00 AM (cutoff 6:30 PM IST)\n\n` +
    `<i>${activeEntries.length} active account(s) me Aaj + Agle 14 Din ke slots ek saath lock kiye ja rahe hain...</i>`,
    { parse_mode: 'HTML' }
  );

  // Process accounts in batches of 2 to stay well under CloudFront burst rate limit (<40 req/10s/IP)!
  const settled = [];
  const CLAIM_BATCH_SIZE = 2;
  for (let b = 0; b < activeEntries.length; b += CLAIM_BATCH_SIZE) {
    const chunk = activeEntries.slice(b, b + CLAIM_BATCH_SIZE);
    const chunkRes = await Promise.all(
      chunk.map(async ([key, acc]) => {
        const accLabel = `${acc.phone || key}${acc.name ? ` (${acc.name})` : ''}`;
        if (effectiveVal) acc.preferredOfferValue = effectiveVal;
        try {
          const claimRes = await claimSwiggyBreakfastAndLateNightOffers(acc, {
            force: true,
            forcePatch: Boolean(effectiveVal),
            offerValue: effectiveVal || acc.preferredOfferValue || 1
          });
          acc.offers = claimRes;
          acc.hasBreakfast = Boolean(claimRes.breakfast?.status === 'CLAIMED');
          acc.hasLateNight = Boolean(claimRes.lateNight?.status === 'CLAIMED');
          if (claimRes.sessionExpired) acc.isLoggedIn = false;
          return { label: accLabel, key, res: claimRes };
        } catch (e) {
          return { label: accLabel, key, res: { success: false, error: e.message } };
        }
      })
    );
    settled.push(...chunkRes);
    if (b + CLAIM_BATCH_SIZE < activeEntries.length) {
      await new Promise(r => setTimeout(r, 350));
    }
  }

  let successCount = 0;
  let partialCount = 0;
  let failCount = 0;
  for (const item of settled) {
    if (item.res?.bothClaimed) successCount++;
    else if (item.res?.success) partialCount++;
    else failCount++;
  }

  saveDb(db);
  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}

  let reportText = section('▣ SWIGGY FREE CASH & EVENT OFFERS (15-DAY AUTO-LOCK)', [
    sub('• Breakfast: 7AM–11AM · ◷ Late Night: 9PM–6AM'),
    sub('Auto-locked before 5:00 AM IST (Breakfast) · 6:30 PM IST (Late Night)'),
  ].join('\n')) + '\n';

  const offerTableRows = [['Account', 'Breakfast', 'Late Night', 'Status']];
  for (const item of settled) {
    const r = item.res;
    if (r.error || r.reason) {
      offerTableRows.push([
        `<b>${escapeHtml(item.label)}</b>`,
        `× Error`,
        `× Error`,
        `<code>${escapeHtml(r.error || r.reason)}</code>`,
      ]);
      continue;
    }

    const bf = r.breakfast || {};
    const ln = r.lateNight || {};
    const bfTag = bf.status === 'CLAIMED' ? '✓' : '×';
    const lnTag = ln.status === 'CLAIMED' ? '✓' : '×';
    const bfMsg = escapeHtml(bf.message || bf.rawMessage || 'Done');
    const lnMsg = escapeHtml(ln.message || ln.rawMessage || 'Done');

    offerTableRows.push([
      `<b>${escapeHtml(item.label)}</b>`,
      `${bfTag} ${bfMsg}`,
      `${lnTag} ${lnMsg}`,
      '✓ Claimed',
    ]);
  }
  reportText += table(offerTableRows) + '\n';

  reportText += section('▤ Summary', [
    field('Fully Locked', `<b>${successCount}</b>`),
    field('Partial', `<b>${partialCount}</b>`),
    field('Expired', `<b>${failCount}</b>`),
    skippedCount > 0 ? field('Logged-out Skipped', `<i>${skippedCount}</i>`) : '',
    sub('Tap any reward button below to switch ALL IDs instantly across all 15 days!'),
  ].filter(Boolean).join('\n'));

  const buttons = [
    [
      Markup.button.callback('₹ ₹50 Free Cash (>₹199)', 'boss_claim_val_1'),
      Markup.button.callback('# ₹150 OFF (>₹249)', 'boss_claim_val_2')
    ],
    [
      Markup.button.callback('! ₹175 LN / ₹100 BF', 'boss_claim_val_3'),
      Markup.button.callback('! ₹100 OFF (>₹149)', 'boss_claim_val_4')
    ],
    [
      Markup.button.callback('↻ Refresh Status', 'boss_claim_all_event_offers'),
      Markup.button.callback('◉ View Accounts', 'boss_view_accounts')
    ],
    [
      Markup.button.callback('⌂ Boss Panel', 'boss_panel_home')
    ]
  ];

  await sendSafeHtml(ctx, reportText, Markup.inlineKeyboard(buttons));
}

bot.command('claim', async (ctx) => {
  const argNum = Number(String(ctx.message?.text || '').trim().split(/\s+/)[1]);
  await runBossEventOffersClaim(ctx, [1, 2, 3, 4].includes(argNum) ? argNum : null);
});

bot.action('boss_claim_all_event_offers', async (ctx) => {
  await runBossEventOffersClaim(ctx, null);
});

bot.action(/^boss_claim_val_([1234])$/, async (ctx) => {
  await runBossEventOffersClaim(ctx, Number(ctx.match[1]));
});

// Switch Active Account Picker
bot.action('boss_switch_active_picker', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const accounts = db.config.accounts || {};
  const buttons = [];
  for (const [k, a] of Object.entries(accounts)) {
    const isAct = db.config.activeOrderAccount === k ? '★ ' : '';
    buttons.push([Markup.button.callback(`${isAct}${a.name || k} (${a.phone || ''})`, `boss_set_active_${k}`)]);
  }
  buttons.push([Markup.button.callback('← Back', 'boss_view_accounts')]);

  await ctx.reply(
    `↻ <b>SELECT ACTIVE ACCOUNT FOR ORDERS:</b>\n\n` +
    `Orders place karte waqt by-default kaunsa account use karna hai?`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action(/^boss_set_active_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) {
    // The card is stale (account removed / re-imported). Show the live picker, not a dead header.
    await ctx.answerCbQuery('Yeh account ab vault me nahi hai — updated list khol raha hoon', { show_alert: true }).catch(() => {});
    const pickerButtons = [];
    for (const [k, a] of Object.entries(db.config?.accounts || {})) {
      const isAct = db.config.activeOrderAccount === k ? '★ ' : '';
      pickerButtons.push([Markup.button.callback(`${isAct}${a.name || k} (${a.phone || ''})`, `boss_set_active_${k}`)]);
    }
    if (pickerButtons.length === 0) {
      return ctx.reply('↻ <b>SELECT ACTIVE ACCOUNT FOR ORDERS:</b>\n\n<i>Vault me abhi koi account nahi hai.</i>', { parse_mode: 'HTML' })
        .catch(() => {});
    }
    pickerButtons.push([Markup.button.callback('← Back', 'boss_view_accounts')]);
    return ctx.reply(
      '↻ <b>SELECT ACTIVE ACCOUNT FOR ORDERS:</b>\n\n<i>Yeh card purana tha, abhi ka account list niche hai.</i>',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(pickerButtons) }
    ).catch(() => {});
  }

  setActiveOrderAccountKey(key);
  await ctx.answerCbQuery(`Active account set to ${acc.name || key} ★`).catch(() => {});
  await showFamilyAccounts(ctx);
});


// ================= VOICE MESSAGE HANDLER =================

bot.on('voice', async (ctx) => {
  const userId = ctx.from.id;

  if (isBoss(userId) && userWaitState[userId]?.action === 'reply_voice') {
    const targetUserId = userWaitState[userId].targetUserId;
    const orderId = userWaitState[userId].orderId;
    delete userWaitState[userId];

    try {
      await bot.telegram.sendVoice(targetUserId, ctx.message.voice.file_id, {
        caption: `♥ <b>Beta ka aawaaz sandesh (Order #${orderId}):</b>`,
        parse_mode: 'HTML'
      });
      await ctx.reply(`✓ <b>Voice note successfully sent to Ammi/Abbu!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to deliver voice note: ${err.message}`);
    }
    return;
  }

  const db = getDb();
  const role = getFamilyRole(userId, 'Ammi');
  const orderId = generateOrderId();

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username || null,
    type: 'VOICE',
    fileId: ctx.message.voice.file_id,
    address: null,
    cart: null,
    selectedAccount: getActiveOrderAccountKey(db),
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString()
  };

  db.orders[orderId] = newOrder;
  saveDb(db);

  await ctx.reply(
    `♥ <b>Aapki aawaaz beta tak pahunch gayi hai!</b>\n\n` +
    `<i>Beta abhi aapka voice note sun kar Swiggy se order place kar rahe hain. Aap befikr rahiye.</i>`,
    { parse_mode: 'HTML' }
  );

  for (const bossId of db.config.bossIds) {
    try {
      const card = formatBossOrderCard(newOrder);
      await sendCardSafe(bossId, card);
      const userProfileUrl = `tg://user?id=${newOrder.userId}`;
      await bot.telegram.sendVoice(bossId, ctx.message.voice.file_id, {
        caption: `• <b>Listen to <a href="${userProfileUrl}">${role}</a>'s Voice Note (Request #${orderId})</b>\n# <b>User TG ID:</b> <a href="${userProfileUrl}">${newOrder.userId}</a>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Failed to notify boss of voice note:', e.message);
    }
  }
});

// ================= PHOTO HANDLER =================

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];

  // If Boss sends/forwards a photo with a Cart/Address caption (not while manually uploading a custom QR), handle via Unified Card Flow!
  if (
    isBoss(userId) &&
    (!state || state.action !== 'waiting_custom_qr_photo') &&
    ctx.message?.caption &&
    (extractForwardSenderInfo(ctx.message) || looksLikeBossOrderInput(ctx.message.caption))
  ) {
    delete userWaitState[userId];
    void handleBossForwardedOrderInput(ctx, {
      rawText: ctx.message.caption.trim(),
      formatOrderBodyFn: formatUserOrderCardText,
      nonBlockingAutoSync: true
    }).catch(e => console.error('[BossPhotoOrderIntake]', e));
    return;
  }

  if (state && (state.action === 'waiting_qr' || state.action === 'waiting_custom_qr_photo')) {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('× Order could not be found.');

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;

    order.customQrFileId = fileId;
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);

    const payable = order.finalPayable || 350;
    const userButtons = [
      [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
      [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
    ];
    if (order.cart && order.cart.startsWith('http')) {
      userButtons.splice(1, 0, [Markup.button.url('▤ Open Swiggy Cart / Items', order.cart)]);
    }

    try {
      await bot.telegram.sendPhoto(order.userId, fileId, {
        caption: `● <b>Swiggy Real Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne authorized Swiggy payment QR bhej diya hai! Kisi bhi UPI app (Google Pay / PhonePe / Paytm) se scan karke payment karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });

      await ctx.reply(`✓ <b>Custom Swiggy QR successfully delivered to ${escapeHtml(order.userName)}!</b>\n\nUser ke payment confirm karte hi Swiggy live tracking extract hokar dono ko mil jayegi.`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to send screenshot: ${err.message}`);
    }
    return;
  }

  const db = getDb();
  const role = getFamilyRole(userId, 'Ammi');
  const orderId = generateOrderId();
  const photo = ctx.message.photo[ctx.message.photo.length - 1];

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username || null,
    type: 'PHOTO',
    fileId: photo.file_id,
    address: null,
    cart: null,
    selectedAccount: getActiveOrderAccountKey(db),
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    createdAt: new Date().toISOString()
  };

  db.orders[orderId] = newOrder;
  saveDb(db);

  await ctx.reply(
    `♥ <b>Parchi / Photo beta tak pahunch gayi hai!</b>\n\n` +
    `<i>Beta abhi samaan dekh kar order kar rahe hain.</i>`,
    { parse_mode: 'HTML' }
  );

  for (const bossId of db.config.bossIds) {
    try {
      const card = formatBossOrderCard(newOrder);
      await sendCardSafe(bossId, card);
      const userProfileUrl = `tg://user?id=${newOrder.userId}`;
      await bot.telegram.sendPhoto(bossId, photo.file_id, {
        caption: `▣ <b>Photo / List sent by <a href="${userProfileUrl}">${role}</a> (Request #${orderId})</b>\n# <b>User TG ID:</b> <a href="${userProfileUrl}">${newOrder.userId}</a>`,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error('Failed to notify boss of photo:', e.message);
    }
  }
});

// Coalesced Multi-File `.json` / `.txt` / `.zip` Account Vault Importer (1 to 200+ files at once — ZERO 429 drops!)
const bulkAccountDocCollector = createBulkDocumentBatchCollector({
  windowMs: 650,
  downloadBufferFn: async (docMeta) => {
    const fileLink = await docMeta.ctx.telegram.getFileLink(docMeta.fileId);
    const res = await fetch(fileLink.href, { signal: AbortSignal.timeout(20000) });
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  },
  onBatchComplete: async ({ lastCtx, statusMsg, rawEntries = [], filesCount = 0, dlErrors = [], result }) => {
    if (statusMsg?.message_id) {
      try { await bot.telegram.deleteMessage(lastCtx.chat.id, statusMsg.message_id); } catch (e) {}
    }

    const accountsToProcess = [];
    for (const item of (rawEntries || [])) {
      const fileName = item.fileName || 'session.json';
      const text = item.text || '';
      const list = extractSwiggyAccountsListFromInput(text);
      for (const acc of list) {
        accountsToProcess.push({ entry: acc, fileName });
      }
    }

    if (accountsToProcess.length === 0) {
      await lastCtx.reply('! File(s) me koi valid Swiggy session nahi mila. Kripya valid .json / .txt / .zip file bhejein.');
      return;
    }

    let successCount = 0;
    let expiredCount = 0;
    const processedKeys = [];

    for (let i = 0; i < accountsToProcess.length; i++) {
      const item = accountsToProcess[i];
      const res = await processAccountEntrySequentially(lastCtx, item.entry, {
        index: i + 1,
        total: accountsToProcess.length,
        fileName: item.fileName
      });
      if (res.success && res.key) processedKeys.push(res.key);
      if (res.success) successCount++;
      else if (res.expired) expiredCount++;
      if (i < accountsToProcess.length - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    if (accountsToProcess.length > 1) {
      const liveDb = getDb();
      const processedList = processedKeys
        .map((k) => liveDb.config?.accounts?.[k])
        .filter(Boolean);
      const truthLine = (a) => (a.ordersVerifiedLive === true
        ? (Number(a.totalOrdersCount) === 0 ? '★ 0 orders (LIVE)' : `● ${Number(a.totalOrdersCount)} orders (LIVE)`)
        : '⚠️ live check pending');
      const lines = processedKeys.map((k, i) => {
        const a = liveDb.config?.accounts?.[k];
        if (!a) return `${i + 1}. × <code>${k}</code> — save fail`;
        const act = a.offerAutoActivation || {};
        // Har offer ka sach: ✓ = ₹50 free cash read-back se verify hua,
        // ⏳ = pre-lock, 🟡 = Swiggy ne doosra reward rakha, ✕ = nahi hua.
        const mark = (st) => {
          const v = String(st || '').toUpperCase();
          if (v === 'CLAIMED' || v === 'ALREADY_CLAIMED') return '✓';
          if (v === 'PRE_LOCKED') return '⏳';
          if (v === 'WRONG_REWARD' || v === 'CLAIMED_OTHER_VALUE') return '🟡';
          return '✕';
        };
        const cells = OFFER_TRACKS.map((t) => `${t.emoji || ''}${mark(act[t.key]?.status)}`).join(' ');
        const claimedN = OFFER_TRACKS.filter((t) => ['CLAIMED', 'ALREADY_CLAIMED'].includes(String(act[t.key]?.status || '').toUpperCase())).length;
        return `${i + 1}. 🟢 <code>${a.phone || k}</code> · ${truthLine(a)} · ₹50×${OFFER_TRACKS.length} → ${cells} (${claimedN}/${OFFER_TRACKS.length})`;
      }).join('\n');
      await lastCtx.reply(
        `<blockquote>✓ <b>ALL FILE ACCOUNTS PROCESSED ONE BY ONE</b></blockquote>\n\n` +
        `▤ Files received: <b>${filesCount || (rawEntries || []).length}</b>` +
        ` · Valid accounts: <b>${accountsToProcess.length}</b>` +
        (dlErrors.length ? ` · File fail: <b>${dlErrors.length}</b>` : '') + `\n` +
        `● Logged In & Ready: <b>${successCount}</b>\n` +
        (expiredCount > 0 ? `× Expired: <b>${expiredCount}</b>\n` : '') +
        (dlErrors.length ? `× <b>File errors:</b> ${dlErrors.slice(0, 6).map((e) => `<code>${escapeHtml(String(e.fileName || 'file'))}</code>`).join(', ')}${dlErrors.length > 6 ? '…' : ''}\n\n` : '\n') +
        (lines ? `${lines}\n\n` : '') +
        `<i>Order count sirf LIVE Swiggy check se — file ka likha count nahi maana jata.</i>\n` +
        `<i>Har account par tap karke poora JSON + Copy button milega.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('◉ View Connected Accounts', 'boss_view_accounts')],
            [Markup.button.callback('⬇ Send All JSON', 'boss_send_all_json')],
            [Markup.button.callback('⌂ Main Menu', 'boss_panel_home')]
          ])
        }
      );

      // One .json document per imported account (7 fields, exact order).
      for (const k of processedKeys.slice(0, 40)) {
        const a = liveDb.config?.accounts?.[k];
        if (!a) continue;
        const payload = buildPortableSessionJson(a, k);
        const phone = String(a.phone || k).replace(/\D/g, '').slice(-10) || 'session';
        try {
          await lastCtx.replyWithDocument(
            { source: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), filename: `${phone}.json` },
            {
              caption: `▤ <b>${escapeHtml(String(a.name || phone))}</b> · <code>${phone}</code>\n${truthLine(a)}\n<i>name, customerId, mobile, token, tid, sid, deviceId</i>`,
              parse_mode: 'HTML'
            }
          );
        } catch { /* skip individual failures */ }
      }
    }
  }
});

// ================= DOCUMENT HANDLER =================
// Security: enforce file size limits (Telegram reports file_size), timeouts,
// and text truncation to prevent OOM / DoS via huge uploads.
const MAX_JSON_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ZIP_FILE_BYTES  = 20 * 1024 * 1024; // 20 MB
const FETCH_FILE_TIMEOUT_MS = 15000;

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const state = userWaitState[userId];
  const doc = ctx.message.document;
  if (!doc) return;
  try {
  // DoS guard: reject absurdly large files before fetching
  if (typeof doc.file_size === 'number') {
    const limit = /\.zip$/i.test(doc.file_name || '') ? MAX_ZIP_FILE_BYTES : MAX_JSON_FILE_BYTES;
    if (doc.file_size > limit) {
      return ctx.reply(`⛔ File bahut badi hai (${(doc.file_size/1024/1024).toFixed(1)} MB). Max ${limit/1024/1024} MB allowed.`).catch(()=>{});
    }
  }

  // Handle ANY burst of `.json`, `.txt`, `.cookies`, or `.zip` account files sent anytime by Boss!
  if (doc.file_name && /\.(json|txt|cookies?|zip)$/i.test(doc.file_name) && isBoss(userId)) {
    try {
      if (state && state.action === 'waiting_fc_json' && !/\.zip$/i.test(doc.file_name)) {
        delete userWaitState[userId];
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const res = await fetch(fileLink.href, { signal: AbortSignal.timeout(FETCH_FILE_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
        let fileText = await res.text();
        if (fileText.length > MAX_JSON_FILE_BYTES) fileText = fileText.slice(0, MAX_JSON_FILE_BYTES);
        const norm = normalizeSwiggySessionPayload(fileText);
        if (!norm) {
          return ctx.reply('! File me valid Swiggy session nahi mila.');
        }
        const ck = norm.cookies || '';
        const statusMsg = await ctx.reply('◷ <i>Uploaded file se Free Cash check & claim ho raha hai...</i>', { parse_mode: 'HTML' });
        const fcRes = await claimInstamartFreeCash(ck);
        try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
        if (fcRes.status === 'CLAIMED') {
          return ctx.reply(`✓ <b>SUCCESSFULLY CLAIMED ₹${fcRes.amount}!</b>\n₹ Total Balance: <b>₹${fcRes.balance}</b>`, { parse_mode: 'HTML' });
        } else if (fcRes.status === 'ALREADY_CLAIMED') {
          return ctx.reply(`i <b>ALREADY CLAIMED!</b>\n₹ Balance: <b>₹${fcRes.balance}</b>`, { parse_mode: 'HTML' });
        }
        return ctx.reply(`× <b>NOT ELIGIBLE FOR FREE CASH</b>\n₹ Balance: ₹0`, { parse_mode: 'HTML' });
      }

      // Clear any stale login/OTP wait state automatically when Boss sends account JSON files!
      if (state) delete userWaitState[userId];
      // ⚠️ YAHAN AWAIT MAT KARO. Pehle `await enqueue(...)` tha, matlab yeh
      // handler poore batch (verify + cards + claims, minute tak) tak chalta
      // rehta tha. Update dispatcher ek waqt me sirf UPDATE_CONCURRENCY (6)
      // updates chalata hai — isliye 6 file ke baad baaki files ka handler shuru
      // hi nahi hota tha aur batch sirf 6 files ka ban jata tha ("jitni bhi file
      // bhejo, 6 hi upload hoti dikhti thi"). Ab handler turant return karta
      // hai, saari files ek hi bucket me jaati hain, aur summary
      // `onBatchComplete` bhejta hai.
      void bulkAccountDocCollector.enqueue(String(ctx.chat.id), ctx, {
        ctx,
        fileId: doc.file_id,
        fileName: doc.file_name
      });
      return;
    } catch (e) {
      console.error('[document] boss file error:', e?.message||e);
      return ctx.reply('! Session file process karne me error aaya: ' + (e?.message||'unknown')).catch(()=>{});
    }
  }

  if (state && (state.action === 'waiting_qr' || state.action === 'waiting_custom_qr_photo')) {
    try {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('× Order could not be found.');

    // Validate payable is real (prevent ₹0 QR exploit)
    const payable = Number(order.finalPayable || 0);
    if (!payable || payable <= 0) return ctx.reply('⛔ QR nahi bhej sakte — bill amount ₹0 hai. Pehle valid bill generate karein.').catch(()=>{});

    order.customQrFileId = doc.file_id;
    order.qrSent = true;
    saveDb(db);
    await updateOrderCards(order);

    const userButtons = [
      [Markup.button.url('◎ Open Swiggy Payment Page', 'https://www.swiggy.com/payments')],
      [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)]
    ];
    if (order.cart && order.cart.startsWith('http')) {
      userButtons.splice(1, 0, [Markup.button.url('▤ Open Swiggy Cart / Items', order.cart)]);
    }

    try {
      await bot.telegram.sendDocument(order.userId, doc.file_id, {
        caption: `● <b>Swiggy Real Payment QR (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}\n` +
          `₹ <b>Total Amount (On Swiggy Payment Page):</b> <b>₹${payable}</b>\n` +
          (order.totalSavings > 0 ? `✓ <b>Discounts & Offers Saved:</b> ₹${order.totalSavings}\n` : '') +
          `\n<i>Beta ne authorized Swiggy payment QR document bhej diya hai! QR scan karke payment karein:</i>`,
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(userButtons)
      });
      await ctx.reply(`✓ <b>Custom Swiggy QR document successfully delivered to ${escapeHtml(order.userName)}!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[document QR] send failed:', err?.message||err);
      await ctx.reply(`× Failed to send document to user: ${escapeHtml(err.message)}`).catch(()=>{});
    }
    } catch (e) { console.error('[document QR] error:', e?.message||e); }
    return;
  }
  } catch (e) {
    console.error('[document] unhandled error:', e?.stack||e?.message||e);
    try { await ctx.reply('⚠️ Document process me error aaya, dubara try karein.').catch(()=>{}); } catch {}
  }
});

// ================= BOSS CARE ACTIONS =================

// Add the delivery OTP only when Swiggy supplies it; never confuse it with login/payment OTPs.
bot.action(/^boss_delivery_otp_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  let order = lookupOrder(getDb(), orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(getDb(), orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(getDb(), orderId), { show_alert: true }).catch(() => {}); }
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_delivery_otp', orderId };
  await ctx.reply(
    `⌕ <b>Enter the delivery OTP Swiggy provided for order #${escapeHtml(orderId)}.</b>\n` +
    `<i>This is not the Swiggy login or payment OTP.</i>`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Delivery OTP (4–8 digits)' } }
  );
});

// Send Tracking Link to Parent
bot.action(/^boss_tracking_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_tracking', orderId };

  await ctx.reply(
    `↗ <b>Paste the official Swiggy tracking link for order #${escapeHtml(orderId)}.</b>\n\n` +
    `<i>Only a real Swiggy link will be sent to ${escapeHtml(order.userName)}. To add a delivery OTP, use the “Add delivery OTP” button on the order card.</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste the Swiggy tracking URL' }
    }
  );
});

// Reply with Voice
bot.action(/^boss_reply_voice_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'reply_voice', orderId, targetUserId: order.userId };

  await ctx.reply(
    `• <b>Record and send your Voice Message now:</b>\n` +
    `It will be sent straight to ${escapeHtml(order.userName)}.`,
    { parse_mode: 'HTML' }
  );
});

// Tag as Ammi
bot.action(/^boss_tag_ammi_(.+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetUserId = ctx.match[1];
  const orderId = ctx.match[2];

  setFamilyRole(targetUserId, 'Ammi');
  await ctx.answerCbQuery('Tagged as Ammi! ♥').catch(() => {});

  const db = getDb();
  const order = db.orders[orderId];
  if (order) {
    const updated = formatBossOrderCard(order);
    try {
      await ctx.editMessageText(updated.text, { parse_mode: 'HTML', ...updated.keyboard });
    } catch (e) {}
  }
});

// Tag as Abbu
bot.action(/^boss_tag_abbu_(.+)_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const targetUserId = ctx.match[1];
  const orderId = ctx.match[2];

  setFamilyRole(targetUserId, 'Abbu');
  await ctx.answerCbQuery('Tagged as Abbu! ◉').catch(() => {});

  const db = getDb();
  const order = db.orders[orderId];
  if (order) {
    const updated = formatBossOrderCard(order);
    try {
      await ctx.editMessageText(updated.text, { parse_mode: 'HTML', ...updated.keyboard });
    } catch (e) {}
  }
});

// Accept Order
bot.action(/^boss_action_accept_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!canTransitionOrder(order.status, 'ACCEPTED') || order.status !== 'PENDING') {
    return ctx.answerCbQuery(`Cannot accept: order is currently ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'ACCEPTED';
  order.acceptedAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('✓ Order Accepted!').catch(() => {});
  await updateOrderCards(order);

  await ctx.reply(`✓ <b>Request #${orderId} Accepted!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `✓ <b>Aapka Order Accept Ho Gaya Hai! (#${orderId})</b>\n\n` +
      `Beta ne aapka Swiggy order accept kar liya hai aur processing shuru kar di hai. ↗\n\n` +
      `! <b>Zaroori Suchna:</b>\n` +
      `Agar aapko koi bhi difficulty, issue ya samasya aati hai, toh kripya direct message karein:\n` +
      `› <b>Support:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
        ])
      }
    );
  } catch (err) {}
});

// Mark as Done
bot.action(/^boss_action_done_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  if (!canTransitionOrder(order.status, 'COMPLETED')) {
    return ctx.answerCbQuery(`Cannot complete: order is currently ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'COMPLETED';
  order.completedAt = new Date().toISOString();
  if (order.selectedAccount && db.config?.accounts?.[order.selectedAccount] && !order.accountOrderCountIncremented) {
    const usedAccObj = db.config.accounts[order.selectedAccount];
    const currentCount = Math.max(0, Number(usedAccObj.totalOrdersCount ?? usedAccObj.cachedTotalOrdersCount ?? 0));
    usedAccObj.totalOrdersCount = currentCount + 1;
    usedAccObj.cachedTotalOrdersCount = currentCount + 1;
    usedAccObj.isZeroOrderAccount = false;
    order.accountOrderCountIncremented = true;
  }
  saveDb(db);

  await ctx.answerCbQuery('✓ Marked as Completed!').catch(() => {});
  const updatedCard = formatBossOrderCard(order);
  try {
    await ctx.editMessageText(updatedCard.text, { parse_mode: 'HTML', ...updatedCard.keyboard });
  } catch (e) {}

  await ctx.reply(`✓ <b>Order #${orderId} marked as COMPLETED!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `✓ <b>Order Complete!</b>\n\nAapka samaan/order delivered ho gaya hai. Khuda hafiz! ♥`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {}
});

// Boss generates UPI QR Code / Payment details for Order
bot.action(/^boss_qr_pay_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery('Fetching genuine payment details... !').catch(() => {});

  const payable = order.finalPayable || order.subtotal || 0;
  const bossButtons = [
    [Markup.button.url('◎ Swiggy Payment Page', 'https://www.swiggy.com/payments')],
    [
      Markup.button.callback('▣ Upload Real QR Screenshot', `boss_upload_custom_qr_${orderId}`),
      Markup.button.callback('▣ Live Screen', `boss_live_pay_screen_${orderId}`)
    ],
    [
      Markup.button.callback('₹ Verify Payment from Swiggy', `boss_confirm_paid_${orderId}`)
    ]
  ];

  if (order.customQrFileId) {
    return ctx.replyWithPhoto(order.customQrFileId, {
      caption: `! <b>GENUINE PAYMENT QR</b>\n\n` +
        `⌖ <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
        `◎ <b>Swiggy Checkout:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
        `<i>Real QR image from checkout session.</i>`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    });
  }

  return ctx.reply(
    `! <b>SWIGGY PAYMENT SESSION</b>\n\n` +
    `⌖ <b>Request #${orderId}</b> | Amount: <b>₹${payable}</b>\n` +
    `◎ <b>Swiggy Payment Page:</b> <code>https://www.swiggy.com/payments</code>\n\n` +
    `i <i>Swiggy Desktop Web does not return a dynamic UPI QR in checkout options. User can pay via Swiggy Payment Page or you can upload the Swiggy mobile app QR screenshot.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(bossButtons)
    }
  );
});

// Boss Prompt Send Swiggy Payment Link
bot.action([/^boss_prompt_send_link_(.+)$/, /^boss_send_payment_link_(.+)$/], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_swiggy_link', orderId };
  await ctx.reply(
    `↗ <b>Send Official Swiggy Payment Link (Order #${orderId}):</b>\n\n` +
    `Swiggy checkout page se generated genuine payment link chat me paste karein.\n` +
    `<i>Optional: Amount ke sath bhi likh sakte hain, jaise <code>₹120 https://payments.swiggy.com/...</code> ya seedha URL paste karein.</i>\n\n` +
    `› Yeh authentic link seedha customer ko official payment button ke sath deliver ho jayega!`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Paste Swiggy payment link here...'
      }
    }
  );
});

// Reject Order / Say Sorry
bot.action(/^boss_action_sorry_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {}); }
  if (hasPossibleSwiggyPlacement(order)) {
    return ctx.answerCbQuery('Order Swiggy par ho sakta hai. Original Swiggy account me check/cancel karein; bot se cancel nahi hua.', { show_alert: true }).catch(() => {});
  }


  order.status = 'REJECTED';
  order.rejectedAt = new Date().toISOString();
  order.cancelledAt = new Date().toISOString();
  saveDb(db);

  await ctx.answerCbQuery('× Order Rejected').catch(() => {});
  await updateOrderCards(order);

  await ctx.reply(`× <b>Order #${orderId} Reject kar diya gaya!</b>`, { parse_mode: 'HTML' });

  try {
    await bot.telegram.sendMessage(
      order.userId,
      `× <b>Aapka Order Reject Ho Gaya Hai (#${orderId})</b>\n\n` +
      `Beta ne filhal yeh order reject kar diya hai.\n\n` +
      `Agar koi bhi difficulty ya sawal hai, toh kripya direct message karein:\n` +
      `› <b>Support:</b> @Its_life_001`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')],
          [Markup.button.callback('↻ New Order', 'user_back_to_main')]
        ])
      }
    );
  } catch (err) {}
});

// Boss Cancel Order anytime
bot.action(/^boss_action_cancel_(.+)$/, async (ctx) => {
  const bossUserId = ctx.from?.id;
  if (!isBoss(bossUserId)) {
    return ctx.answerCbQuery('Unauthorized: Boss only', { show_alert: true }).catch(() => {});
  }

  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) {
    console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId));
    return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId), { show_alert: true }).catch(() => {});
  }

  if (hasPossibleSwiggyPlacement(order)) {
    return ctx.answerCbQuery('Order Swiggy par ho sakta hai. Original Swiggy account me check/cancel karein; bot se cancel nahi hua.', { show_alert: true }).catch(() => {});
  }

  if (order.status === 'CANCELLED') {
    return ctx.answerCbQuery(`Order #${orderId} is already cancelled`, { show_alert: true }).catch(() => {});
  }

  // 1. Mark order CANCELLED by Boss
  order.status = 'CANCELLED';
  order.cardStage = 'CANCELLED';
  order.cancelledAt = new Date().toISOString();
  order.cancelledBy = 'BOSS';
  order.cancelledReason = 'Cancelled by Boss';

  // 2. Free account reservation if bound
  const freedAccKey = order.selectedAccount;
  if (freedAccKey) {
    try { releaseSwiggyAccountReservation(freedAccKey, order.id); } catch {}
  }
  // 2b. 🔒 Durable lock bhi chhodo — ID turant naye order ke liye free.
  try { await closeOrderAccountLock(order.id, { reason: 'boss ne order cancel kiya', telegram: bot.telegram }); } catch {}

  // 3. Stop auto tracking and payment pollers
  try { stopOrderTrackingAuto(order.id); } catch {}
  try { stopOrderPaymentPoller(order.id); } catch {}

  // 4. Clear user draft
  try { clearDraft(order.userId); } catch {}

  saveDb(db);

  await ctx.answerCbQuery(`❌ Order #${order.id} Cancelled`, { show_alert: true }).catch(() => {});

  // 5. Update Boss card and User card in-place
  await updateOrderCards(order).catch(() => {});

  // 6. Send explicit cancellation confirmation to Boss in current chat
  const custName = escapeHtml(order.userName || 'Customer');
  const userProfileUrl = `tg://user?id=${order.userId}`;
  await ctx.reply(
    `❌ <b>Order #${order.id} Cancelled by Boss!</b>\n\n` +
    `• <b>Customer:</b> <a href="${userProfileUrl}">${custName}</a> (TG ID: <code>${order.userId}</code>)\n` +
    `• <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy')}\n` +
    `• <b>Amount:</b> ₹${order.finalPayable || order.payableAmount || 0}\n` +
    (freedAccKey ? `• <b>Account Freed:</b> <code>${escapeHtml(freedAccKey)}</code>\n` : '') +
    `• <b>Status:</b> <b>CANCELLED</b>\n\n` +
    `<i>Customer ko cancellation notification aur naya order button bhej diya gaya hai.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('← Back to Panel', 'boss_refresh')],
        [Markup.button.callback('× View Cancelled Orders', 'boss_view_cancelled_orders')]
      ])
    }
  ).catch(() => {});

  // 7. Send notification to Customer / User
  try {
    if (order.userId) {
      await bot.telegram.sendMessage(
        order.userId,
        `❌ <b>Aapka Order #${order.id} Admin dwara CANCEL kar diya gaya hai.</b>\n\n` +
        `Agar aapko koi dikkat ya sawal hai, toh support se direct sampark karein ya naya order place karein:\n` +
        `› <b>Support:</b> @Its_life_001`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')],
            [Markup.button.callback('🛒 Naya Order Shuru Karein', 'user_back_to_main')]
          ])
        }
      );
    }
  } catch (err) {
    console.error(`Failed to send cancellation message to user ${order.userId}:`, err.message);
  }
});

// Upload SS / QR prompt
bot.action(/^boss_qr_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_qr', orderId };

  await ctx.reply(
    `▣ <b>Upload Screenshot / QR for Order #${orderId}:</b>\n\n` +
    `Tap • icon to choose photo from gallery.`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Pick photo...' }
    }
  );
});

// ================= FREE CASH & INSTAMART OFFERS =================

async function showFreeCashMenu(ctx) {
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const accKeys = Object.keys(accounts);

  let text = `▣ <b>CLAIM SWIGGY INSTAMART FREE CASH (₹50-₹60) + FREEBIE</b>\n\n` +
    `Bot pehle account run karke Free Cash actively <b>CLAIM</b> karega aur confirm karega:\n` +
    `• ● <b>CLAIMED:</b> Agar naya Free Cash (₹50/₹60) add ho gaya\n` +
    `• ● <b>ALREADY CLAIMED:</b> Agar is account pe pehle se claim ho chuka hai\n` +
    `• ● <b>NOT ELIGIBLE:</b> Agar account is promo offer ke liye eligible nahi hai\n\n` +
    `<i>Niche apna account select karein ya naya Session JSON / Cookies paste karein:</i>`;

  const buttons = [];
  const accButtons = [];
  for (const k of accKeys) {
    const acc = accounts[k];
    const label = `▣ ${acc.name || k} (${acc.phone || 'Saved'})`;
    accButtons.push(Markup.button.callback(label, `boss_check_fc_${k}`));
  }
  for (let i = 0; i < accButtons.length; i += 2) {
    buttons.push(accButtons.slice(i, i + 2));
  }

  buttons.push([Markup.button.callback('▤ Paste / Upload Session JSON', 'boss_paste_fc_json')]);
  buttons.push([Markup.button.callback('← Back to Main Panel', 'user_back_to_main')]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

bot.command(['freecash', 'claim', 'claim_freecash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

bot.hears(['▣ Claim Free Cash', '₹ Cash Loot', '₹ Claim Free Cash', 'Claim Free Cash', 'claim free cash', 'Free Cash', 'free cash'], async (ctx) => {
  await showFreeCashMenu(ctx);
});

bot.action('boss_claim_freecash', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showFreeCashMenu(ctx);
});

bot.action('boss_paste_fc_json', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_fc_json' };
  await ctx.reply(
    `▤ <b>Paste / Upload Swiggy Session JSON / Cookies:</b>\n\n` +
    `Apne account ka session JSON ya cookies yahan chat me paste karein.\n` +
    `Bot pehle account ko run karke Free Cash claim karega aur turant batayega:\n` +
    `• <b>CLAIMED</b> (₹50-₹60 credited)\n` +
    `• <b>ALREADY CLAIMED</b> (pehle se availed)\n` +
    `• <b>NOT ELIGIBLE</b> (offer not valid)`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON or cookies here...' }
    }
  );
});

bot.action(/^boss_check_fc_(.+)$/, async (ctx) => {
  const accKey = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[accKey];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  if (!acc.cookies) {
    return ctx.answerCbQuery('Account me saved cookies/session nahi hai! Pehle login karein.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery('Running Swiggy Instamart claim engine... ◷').catch(() => {});
  const statusMsg = await ctx.reply(`◷ <i>Running Instamart Claim Engine for <b>${escapeHtml(acc.name || accKey)}</b>... Please wait 5-10 seconds...</i>`, { parse_mode: 'HTML' });

  const res = await claimInstamartFreeCash(acc.cookies);

  const accName = escapeHtml(acc.name || accKey);
  const accPhone = escapeHtml(acc.phone || 'N/A');

  if (res.status === 'CLAIMED') {
    const successText = `✓ <b>SUCCESSFULLY CLAIMED!</b> ♥\n\n` +
      `◉ <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `₹ <b>Claimed Free Cash:</b> <b>₹${res.amount}</b> (Credited to Swiggy Money!)\n` +
      `₹ <b>Total Current Balance:</b> <b>₹${res.balance}</b>\n` +
      `▣ <b>Instamart Freebie:</b> UNLOCKED ✓ (Eligible for Freebie on orders above ₹199!)\n` +
      (res.swiggyOne ? `★ <b>Swiggy One:</b> Active (Free Delivery Included)\n` : `↗ <b>Delivery:</b> Free delivery on Instamart\n`) +
      `\n<i>Mubarak ho! Bot ne account run karke Free Cash successfully claim kar liya hai. Ammi/Abbu ke liye Instamart grocery mangwayein aur direct ₹${res.balance} discount enjoy karein!</i>`;

    const buttons = [
      [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
      [Markup.button.callback('↻ Check Another Account', 'boss_claim_freecash')]
    ];
    await ctx.reply(successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } else if (res.status === 'ALREADY_CLAIMED') {
    const alreadyText = `i <b>ALREADY CLAIMED!</b>\n\n` +
      `◉ <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `! <b>Status:</b> Is account par Free Cash pehle se claim ho chuka hai.\n` +
      `₹ <b>Available Swiggy Money Balance:</b> <b>₹${res.balance}</b>\n\n` +
      `<i>Yeh balance aapke account me already maujood hai. Aap isse Instamart checkout par use kar sakte hain!</i>`;

    const buttons = [
      [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
      [Markup.button.callback('↻ Check Another Account', 'boss_claim_freecash')],
      [Markup.button.callback('▤ Paste Another Session JSON', 'boss_paste_fc_json')]
    ];
    await ctx.reply(alreadyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } else {
    const notEligibleText = `× <b>NOT ELIGIBLE FOR FREE CASH</b>\n\n` +
      `◉ <b>Account:</b> ${accName} (<code>${accPhone}</code>)\n` +
      `₹ <b>Free Cash Balance:</b> ₹0\n\n` +
      `<i>Yeh account is promotional Free Cash offer ke liye eligible nahi hai.\n` +
      `Note: Yeh promo offers Swiggy ke naye accounts ya targeted users ke liye aate hain. Aap dusra account try karein!</i>`;

    const buttons = [
      [Markup.button.callback('↻ Check Another Account', 'boss_claim_freecash')],
      [Markup.button.callback('▤ Paste / Upload Session JSON', 'boss_paste_fc_json')]
    ];
    await ctx.reply(notEligibleText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  }

  try {
    await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (e) {}
});

// ================= USER & BOSS BOTTOM MENU HEARS =================

// USER BUTTONS (Colorful Orange Cart & Address Buttons + All Aliases)
bot.hears([
  '🟠 🛒 Cart Link', '🟢 🛒 Cart ✓', '🟠 Cart Link', '🟢 Cart ✓',
  '🛒 Cart Link', 'Cart Link', '🛒 Cart ✓',
  '● Cart link', '● change cart link', 'Cart link', 'change cart link',
  '● Paste cart link', 'Paste cart link', 'Cart', '● Cart: Added ✓',
  '● Paste Cart Link', 'Paste Cart Link', 'Cart: Added'
], async (ctx) => {
  await handleCartLinkFlow(ctx);
});

bot.hears([
  '🟠 📍 Address Link', '🟢 📍 Address ✓', '🟠 Address Link', '🟢 Address ✓',
  '📍 Address Link', 'Address Link', '📍 Address ✓',
  '● Address link', '● change address link', 'Address link', 'change address link',
  '● Paste address Link', 'Paste address Link', 'Address', '● Address: Added ✓',
  '● Paste Address Link', 'Paste Address Link', 'Address: Added'
], async (ctx) => {
  await handleAddressLinkFlow(ctx);
});

bot.hears([
  '🚀 Send to Beta',
  'Order Screen', 'Customer Screen', '▣ Order Screen',
  'Send Order to Beta', 'send order to beta', 'SEND ORDER TO BETA',
  'Send to Beta', 'send to beta',
  'Send to Boss', 'send to boss', 'SEND TO BOSS',
  'Send to Admin', '› Send to Beta',
  /send.*order.*beta/i, /send.*beta/i, /send.*boss/i, /send.*admin/i
], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    await ctx.reply('Boss Menu:', getBossReplyKeyboard());
    return ctx.reply(getBossPanelText(), { parse_mode: 'HTML', ...getBossPanelKeyboard() });
  }
  await handleSendToBoss(ctx);
});

bot.command(['sendtobeta', 'send_to_beta', 'sendorder', 'send_order', 'order'], async (ctx) => {
  await handleSendToBoss(ctx);
});

bot.hears(['✖ Cancel Draft', 'Cancel Draft', 'cancel draft', '● Cancel Draft'], async (ctx) => {
  const userId = ctx.from.id;
  clearDraft(userId, { clearMiniAppLinks: true });
  delete userWaitState[userId];
  await ctx.reply('✖ <b>Draft clear ho gaya!</b>', { parse_mode: 'HTML', ...getUserReplyKeyboard() });
  return renderUserCard(ctx, userId);
});

bot.action(['action_clear_draft', 'action_cancel_draft'], async (ctx) => {
  await ctx.answerCbQuery('Draft Cleared').catch(() => {});
  const userId = ctx.from.id;
  clearDraft(userId, { clearMiniAppLinks: true });
  delete userWaitState[userId];
  const screen = getUserScreen(userId, ctx.from);
  try {
    await ctx.editMessageText(screen.text, {
      parse_mode: 'HTML',
      ...screen.keyboard
    });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

bot.hears(['✖ Cancel Order', '✖ Cancel', 'Cancel Order', 'cancel order', 'Cancel order', '● cancel order', '● Cancel Order'], async (ctx) => {
  await handleCancelOrderConfirm(ctx);
});

// NOTE: the bare 'Previous Orders' label belongs to the Boss account-history
// screen (registered later); the customer menu only uses the 📦 button.
bot.hears(['📦 Previous Order', 'previous order', 'Previous order', '○ previous order'], async (ctx) => {
  await handlePreviousOrder(ctx);
});

// 'Claim Free Cash' is already registered in the FREE CASH section above — a
// second handler there would shadow it, so main's duplicate copy is dropped.
// BOSS ONLY BOTTOM BUTTONS
bot.hears(['Pending Orders', '● Pending Orders', '▣ Pending Orders'], async (ctx) => {
  if (isBoss(ctx.from.id)) await sendPendingOrdersToBoss(ctx.from.id);
});

bot.hears(['Connected Accounts', '● Connected Accounts', '◉ My Swiggy Accounts'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleMyAccounts(ctx);
});

bot.hears(['Saved Addresses', '● Saved Addresses', '⌖ Saved Addresses'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handleSavedAddresses(ctx);
});

// Slot gating was removed: orders are unlimited, so this button now answers the
// real state instead of silently re-rendering the generic panel.
bot.hears(['Slot Status', '● Slot Status', '# Slot Status'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await ctx.reply(
    '✓ <b>Slot system band hai</b> — ab unlimited orders direct chalte hain. Koi slot book karne ki zarurat nahi.',
    { parse_mode: 'HTML', ...getBossPanelKeyboard() }
  );
});

// Reply-keyboard "Order History" had no handler at all and was being read as an
// order id ("Order Order not found"). Point it at the real archive.
bot.hears(['▤ Order History', 'Order History', 'order history'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.reply('Unauthorized: Boss only');
  await showSuccessOrdersArchive(ctx);
});

bot.hears(['Set UPI ID', '● Set UPI ID'], async (ctx) => {
  if (isBoss(ctx.from.id)) {
    userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
    const cur = String(getDb().config?.bossUpiId || '').trim() || '(set nahi hai)';
    await ctx.reply(
      `₹ <b>Set Boss Payment UPI ID:</b>\nCurrent: <code>${cur}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('Main Menu', 'boss_panel_home'),
            Markup.button.callback('Close', 'close_menu')
          ]
        ])
      }
    );
    await ctx.reply('› Enter UPI ID:', {
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID (e.g. name@upi)...' }
    });
  }
});

bot.hears(['Login Swiggy', '○ Login Swiggy'], async (ctx) => {
  if (isBoss(ctx.from.id)) await handlePromptLogin(ctx);
});

bot.hears(['Login with JSON', '◈ Login with JSON'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  userWaitState[ctx.from.id] = { action: 'waiting_json_login' };
  await ctx.reply(
    `<b>LOGIN WITH JSON:</b>\n\n` +
    `Swiggy session / cookie JSON chat me paste karein ya <code>.json</code> file bhej dein:`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Paste session JSON here...' }
    }
  );
});

bot.hears(['Login with Number', '☎ Login with Number'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  await promptBossLoginWithNumber(ctx);
});

// Register complete Forwarded IB + 10x Parallel Zero-Order Auto-Account Order Workflow (`fwd_*` actions)
registerForwardedOrderHandlers(bot, {
  isBoss,
  formatOrderBodyFn: formatUserOrderCardText
});

bot.action(/^fwd_input_(cart|address|mobile)_([A-Za-z0-9_-]+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const [, inputType, orderId] = ctx.match;
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return ctx.answerCbQuery(`Order is ${order.status.toLowerCase()} and cannot be edited.`, { show_alert: true }).catch(() => {});
  }
  if (order.status === 'APPROVAL_PENDING' || order.billApprovedByUser) {
    return ctx.answerCbQuery('Bill approval is in progress or complete; delivery details are locked.', { show_alert: true }).catch(() => {});
  }
  if (order.pendingSwiggyOrderId || order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.cardStage === 'QR_GENERATED') {
    return ctx.answerCbQuery('Swiggy checkout is already active. Cancel or resolve it before editing delivery details.', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: `waiting_boss_order_${inputType}`, orderId };
  const prompt = inputType === 'cart'
    ? `▤ <b>Send the genuine Swiggy Cart / Group Cart link for order #${escapeHtml(orderId)}.</b>\n\n<i>The bill will be rechecked after the delivery address and recipient mobile are verified.</i>`
    : inputType === 'mobile'
      ? `☎ <b>Send only the recipient’s correct 10-digit Indian mobile for order #${escapeHtml(orderId)}.</b>\n\n<i>The Swiggy account number will never be substituted for the recipient number.</i>`
      : `⌖ <b>Send the delivery address for order #${escapeHtml(orderId)}.</b>\n\n<i>Use a Swiggy address share, Google Maps link, full street address with area/city/PIN, or share a GPS pin. Include the recipient’s 10-digit mobile if known.</i>`;
  await ctx.reply(prompt, {
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: inputType === 'cart'
        ? 'Paste Swiggy cart link...'
        : (inputType === 'mobile' ? 'Enter recipient mobile...' : 'Paste address or send GPS pin...')
    }
  });
});

// Optional instant QR push toggle (`/autoqr on` | `/autoqr off` | `/autoqr`) for 10x zero-tap QR generation
bot.command('autoqr', async (ctx) => {
  if (!isBoss(ctx.from?.id)) return;
  const arg = String(ctx.message?.text || '').split(/\s+/)[1]?.toLowerCase() || '';
  const db = getDb();
  if (!db.config) db.config = {};
  if (arg === 'on' || arg === '1' || arg === 'true') {
    db.config.autoGenerateQr = true;
  } else if (arg === 'off' || arg === '0' || arg === 'false') {
    db.config.autoGenerateQr = false;
  } else {
    db.config.autoGenerateQr = !Boolean(db.config.autoGenerateQr);
  }
  saveDb(db);
  await ctx.reply(
    `! <b>Auto-QR Mode is now: ${db.config.autoGenerateQr ? '● ON (Instant QR after Auto-Bill Sync)' : '● SMART MANUAL (Auto-Account + Max Offer ON, 1-Click QR button)'}</b>`,
    { parse_mode: 'HTML' }
  );
});

// Detect if pasted text looks like a Swiggy Session JSON
// (used to route boss-pasted session JSON straight to Vault Saver)
function looksLikeSwiggySessionJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return false;
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    const jsonStr = JSON.stringify(obj).toLowerCase();
    return (
      jsonStr.includes('_session_tid') ||
      jsonStr.includes('"tid"') ||
      jsonStr.includes('"token"') ||
      jsonStr.includes('"cookies"') ||
      jsonStr.includes('"customerid"') ||
      jsonStr.includes('"session_id"') ||
      jsonStr.includes('swiggy')
    );
  } catch (e) {
    return false;
  }
}

// Text message handler
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  let state = userWaitState[userId];
  let rawText = ctx.message.text || '';
  // Prevent OOM from huge pasted blocks (e.g., 1MB bill + links)
  if (rawText.length > 8000) {
    rawText = rawText.slice(0, 8000);
    console.warn(`[text] truncated huge message from ${userId}: ${ctx.message.text.length} -> 8000`);
  }
  rawText = rawText.trim();

  // Menu labels and slash commands belong to their dedicated handlers. This
  // catch-all runs first, so swallowing them here made later `bot.hears` /
  // `bot.command` registrations unreachable ("📦 Orders Done", "₹ Cash Loot",
  // "▤ View Cart", …). Hand them over instead.
  if (isCommandText(rawText) || (isMenuText(rawText) && !/^waiting_boss_order_/.test(String(state?.action || '')))) {
    if (state && !/^waiting_(?:cart|address|recipient_mobile)$/.test(String(state.action || ''))) {
      delete userWaitState[userId];
    }
    return next();
  }

  // ================= 👛 WALLET: UTR / BOSS ADJUST / SEARCH (both) =================
  // Yeh states sabse pehle — warna 12-digit UTR "phone number" jaisa lag kar
  // OTP/login guard me chala jata hai.
  if (state && state.action === 'waiting_wallet_utr') {
    delete userWaitState[userId];
    const amountPaise = Number(state.amountPaise || feePaiseNow());
    const userName = String(ctx.from?.first_name || ctx.from?.username || '').trim();
    let submitted;
    try {
      submitted = await submitBotWalletTopup({
        userId, utr: rawText, amountPaise, name: userName,
        username: ctx.from?.username || '', note: 'Wallet recharge', minPaise: 100
      });
    } catch (err) {
      return ctx.reply('Recharge save nahi hua. Dobara payment na bhejein; admin se baat karein.').catch(() => {});
    }
    if (!submitted.ok) {
      userWaitState[userId] = { action: 'waiting_wallet_utr', amountPaise };
      return ctx.reply(`UTR accept nahi hua: ${escapeHtml(submitted.reason || submitted.code || 'invalid')}`, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: 'Admin', callback_data: 'support_contact_admin' }]])
      }).catch(() => {});
    }
    if (submitted.code === 'AUTO_VERIFIED') {
      await ctx.reply(`✅ ₹${walletRupees(submitted.creditedPaise)} added · Balance ₹${walletRupees(submitted.balancePaise)}.`, {
        ...Markup.inlineKeyboard([[{ text: '👛 Wallet', callback_data: 'wallet_home' }]])
      }).catch(() => {});
      await resumeOrderAfterTopup(userId).catch(() => null);
    } else {
      await ctx.reply(`⏳ UTR ${escapeHtml(submitted.request.utr)} pending hai. Verify hone par balance judega.`, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '👛 Wallet', callback_data: 'wallet_home' }]])
      }).catch(() => {});
      await notifyPendingTopup(bot.telegram, submitted.request.id);
      retryPendingWalletUtrs({ telegram: bot.telegram }).catch(() => {});
    }
    return;
  }

  if (state && state.action === 'waiting_wallet_topup_amount') {
    const rawAmount = rawText.trim().replace(/^₹\s*/, '');
    const amount = /^\d{1,9}(?:\.\d{1,2})?$/.test(rawAmount) ? Math.round(Number(rawAmount) * 100) : 0;
    if (amount < 100) return ctx.reply('Amount ₹1 ya zyada bhejein.').catch(() => {});
    delete userWaitState[userId];
    return sendWalletTopupInstructions(ctx, amount);
  }

  if (isBoss(userId) && state && state.action === 'waiting_boss_wallet_upi') {
    const db = getDb();
    const result = setWalletUpiId(db, rawText.trim(), { actor: `boss:${userId}` });
    if (!result.ok) return ctx.reply('Sahi UPI ID bhejein, jaise name@bank.').catch(() => {});
    if (!saveDbDurable(db)) return ctx.reply('UPI save nahi hua. Dobara try karein.').catch(() => {});
    delete userWaitState[userId];
    return ctx.reply(`Wallet UPI: ${result.upiId}`).catch(() => {});
  }

  if (isBoss(userId) && state && state.action === 'waiting_boss_utr_amount') {
    const rawAmount = rawText.trim().replace(/^₹\s*/, '');
    const amount = /^\d{1,9}(?:\.\d{1,2})?$/.test(rawAmount) ? Math.round(Number(rawAmount) * 100) : 0;
    if (amount < 100) return ctx.reply('Actual amount ₹1 ya zyada bhejein.').catch(() => {});
    delete userWaitState[userId];
    return completeBossTopupApproval(ctx, state.requestId, amount);
  }

  if (isBoss(userId) && state && state.action === 'waiting_boss_wallet_statement') {
    const db = getDb();
    const imported = importStatementText(db, rawText, { actor: `boss:${userId}` });
    if (!imported.accepted.length) return ctx.reply('Statement me UTR + amount nahi mila. Poori line bhejein.').catch(() => {});
    if (!saveDbDurable(db)) return ctx.reply('Statement save nahi hua.').catch(() => {});
    delete userWaitState[userId];
    backupMoneyNow().catch(() => {});
    for (const item of imported.settled.filter(row => row.action === 'CREDIT')) {
      await bot.telegram.sendMessage(String(item.userId), `✅ ₹${walletRupees(item.creditedPaise)} wallet me added.`).catch(() => {});
      await resumeOrderAfterTopup(item.userId).catch(() => null);
    }
    return ctx.reply(`Statement: ${imported.accepted.length} entries · ${imported.settled.filter(row => row.action === 'CREDIT').length} verified.`).catch(() => {});
  }

  if (isBoss(userId) && state && state.action === 'waiting_boss_utr_lookup') {
    const checked = validateUtr(rawText);
    if (!checked.ok) return ctx.reply('Valid UTR bhejein.').catch(() => {});
    delete userWaitState[userId];
    const lookup = await fetchUtrPaymentDetails(checked.utr, { userId: `boss:${userId}` })
      .catch(err => ({ configured: false, found: false, reason: String(err?.message || err) }));
    const db = getDb();
    const payment = db.config?.upiStatement?.[checked.utr] || (lookup.found ? lookup.payment : null);
    const truth = describeUtrPayment({ utr: checked.utr, payment, lookup, allowedPayeeVpas: [configuredWalletUpiId(db)] });
    return ctx.reply(escapeHtml(truth.bossLine || truth.summaryLine || lookup.reason || 'Payment details nahi mili.'), { parse_mode: 'HTML' }).catch(() => {});
  }

  if (isBoss(userId) && state && (state.action === 'waiting_wallet_credit_amount' || state.action === 'waiting_wallet_debit_amount')) {
    const targetUserId = String(state.targetUserId || '');
    const isCredit = state.action === 'waiting_wallet_credit_amount';
    delete userWaitState[userId];
    const amountRupees = Number(String(rawText).replace(/[^\d.]/g, ''));
    const paise = Math.round((Number.isFinite(amountRupees) ? amountRupees : 0) * 100);
    if (!(paise > 0) || !targetUserId) {
      return ctx.reply('❌ Amount samajh nahi aaya. Jaise <code>100</code> ya <code>15</code> bhejein.', { parse_mode: 'HTML' }).catch(() => {});
    }
    const db = getDb();
    ensureWallet(db, targetUserId);
    const res = isCredit
      ? creditWallet(db, targetUserId, paise, { reason: 'boss ne balance add kiya', actor: `boss:${userId}`, type: 'ADJUST' })
      : debitWallet(db, targetUserId, paise, { reason: 'boss ne balance kata', actor: `boss:${userId}` });
    if (res.ok) saveDb(db);
    return ctx.reply(
      res.ok
        ? `${isCredit ? '➕' : '➖'} <b>₹${walletRupees(paise)} ${isCredit ? 'add' : 'deduct'}</b> — user <code>${escapeHtml(targetUserId)}</code>\n` +
          `New balance: <b>₹${walletRupees(res.balancePaise)}</b>`
        : `❌ Nahi hua — ${escapeHtml(String(res.reason || 'error'))}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '◀ User', callback_data: `boss_wallet_view_${targetUserId}`, style: 'primary' }]]) }
    ).catch(() => {});
  }

  // 🧮 Boss: fee amount set
  if (isBoss(userId) && state && state.action === 'waiting_boss_fee_amount') {
    delete userWaitState[userId];
    const rupeeVal = Number(String(rawText).replace(/[^\d.]/g, ''));
    const paise = Math.round((Number.isFinite(rupeeVal) ? rupeeVal : -1) * 100);
    if (!(paise >= 0)) {
      return ctx.reply('❌ Fee samajh nahi aayi — jaise <code>15</code> ya <code>0</code> bhejein.', { parse_mode: 'HTML' }).catch(() => {});
    }
    const db = getDb();
    const res = setServiceFeePaise(db, paise, { actor: `boss:${userId}` });
    if (res.ok) saveDb(db);
    return sendBossFeePanel(ctx, {
      notice: res.ok
        ? `✅ <b>Fee set: ₹${walletRupees(paise)}</b> per order${paise === 0 ? ' (free)' : ''}`
        : `❌ ${escapeHtml(res.reason || res.code || 'error')}`
    }).catch(() => {});
  }

  // ✉️ Boss: user ko message
  if (isBoss(userId) && state && state.action === 'waiting_boss_user_message') {
    const targetUserId = String(state.targetUserId || '');
    delete userWaitState[userId];
    if (!targetUserId) return;
    const body = String(rawText || '').slice(0, 3500);
    let delivered = true;
    try {
      await bot.telegram.sendMessage(
        targetUserId,
        `📩 <b>ADMIN KA MESSAGE</b>\n\n${escapeHtml(body)}\n\n` +
        `<i>Koi jawab dena ho to neeche "Admin se baat" dabayein.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[{ text: '🆘 Admin se baat karein', callback_data: 'support_contact_admin', style: 'primary' }]])
        }
      );
    } catch (err) {
      delivered = false;
      console.warn('[Support] boss→user message failed:', err?.message || err);
    }
    return ctx.reply(
      delivered
        ? `✅ Message bhej diya — <code>${escapeHtml(targetUserId)}</code>`
        : `❌ Message nahi gaya (user ne bot block kiya ho sakta hai) — <code>${escapeHtml(targetUserId)}</code>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '◀ User', callback_data: `boss_wallet_view_${targetUserId}`, style: 'primary' }]]) }
    ).catch(() => {});
  }

  // 🆘 Customer: admin se baat (kisi bhi issue par)
  if (state && state.action === 'waiting_support_message' && !isBoss(userId)) {
    delete userWaitState[userId];
    const body = String(rawText || '').slice(0, 3000);
    const db = getDb();
    const name = walletNameOf(userId, ctx.from?.first_name || '');
    const username = ctx.from?.username ? `@${ctx.from.username}` : '';
    const activeOrders = Object.values(db.orders || {})
      .filter((o) => String(o?.userId || '') === String(userId))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 2)
      .map((o) => `#${o.id} ${String(o.status || '')} ₹${walletRupees(Number(o.finalPayable || 0) * 100 || 0)}`);
    await ctx.reply(
      '✅ <b>Admin ko bhej diya</b>\n\n<i>Wo yahin reply karega. Aapka message:</i>\n' +
      `<blockquote>${escapeHtml(body)}</blockquote>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    for (const bossId of [...new Set((db.config?.bossIds || []).map(String).filter(Boolean))]) {
      await bot.telegram.sendMessage(
        bossId,
        `🆘 <b>USER MESSAGE (admin)</b>\n` +
        `From: <b>${escapeHtml(name || String(userId))}</b> · <code>${escapeHtml(String(userId))}</code>${username ? ` · ${escapeHtml(username)}` : ''}\n` +
        (activeOrders.length ? `Orders: ${activeOrders.map((x) => escapeHtml(x)).join(' · ')}\n` : '') +
        `\n<blockquote>${escapeHtml(body)}</blockquote>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            { text: '✉️ Reply karein', callback_data: `boss_wallet_msg_${userId}`, style: 'success' },
            { text: '◀ User', callback_data: `boss_wallet_view_${userId}`, style: 'primary' }
          ]])
        }
      ).catch(() => {});
    }
    return;
  }

  if (isBoss(userId) && state && state.action === 'waiting_boss_wallet_search') {
    delete userWaitState[userId];
    return sendBossWalletList(ctx, { query: rawText, notice: '' }).catch(() => {});
  }

  // New private-chat links are only collected here. No account is chosen and
  // no Swiggy request, bill, or order starts in Telegram chat. Forwarded/admin
  // work and unrelated wait states keep their existing paths.
  const handoffWaits = new Set(['waiting_cart', 'waiting_address', 'waiting_both_links',
    'waiting_miniapp_cart', 'waiting_miniapp_address', 'classify_miniapp_link']);
  if (chatHandoffEnabled() && ctx.chat?.type === 'private' && (!isBoss(userId) || !extractForwardSenderInfo(ctx.message)) &&
      (!state || handoffWaits.has(state.action))) {
    const parsed = parseChatShareLinks(rawText);
    const found = Boolean(parsed.cart || parsed.address || parsed.ambiguous.length);
    if (parsed.duplicates.length) {
      await ctx.reply('Ek cart aur ek address link bhejein.');
      return;
    }
    if (found) {
      const links = { ...(parsed.cart ? { cart: parsed.cart } : {}), ...(parsed.address ? { address: parsed.address } : {}) };
      if (parsed.ambiguous.length) {
        const pending = { action: 'classify_miniapp_link', links, urls: [...parsed.ambiguous], number: 1 };
        userWaitState[userId] = pending;
        await askChatLinkKind(ctx, pending);
      } else {
        await recordChatHandoffLinks(ctx, links);
      }
      return;
    }
    if (parsed.unsupported.some(link => /(?:swiggy|swig\.gy|maps\.app|maps\.google|goo\.gl\/maps)/i.test(link) && !isOfficialSwiggyTrackingUrl(link))) {
      await ctx.reply('Swiggy ka cart aur address share link bhejein.');
      return;
    }
    if (state && ['waiting_miniapp_cart', 'waiting_miniapp_address', 'classify_miniapp_link'].includes(state.action) &&
        !rawText.startsWith('/')) {
      await ctx.reply('Sahi Swiggy cart ya address link bhejein.');
      return;
    }
  }

  // ================= PRIORITY #1: ZERO-OTP CART / ADDRESS / JSON GUARD (BOTH BOSS & CUSTOMERS!) =================
  // NEVER let a stale OTP wait state OR digits inside a Swiggy URL / Address hijack ANY Cart, Address, or Session JSON!
  if (isBoss(userId)) {
    // 1A-0. Boss broadcast message wait state
    if (state && state.action === 'waiting_broadcast_message') {
      delete userWaitState[userId];
      await executeBroadcast(ctx, rawText);
      return;
    }

    // 1A. Pasted Session JSON anywhere in chat -> straight to Vault Saver (clears any stale OTP wait state!)
    if (
      (!state || state.action !== 'waiting_fc_json') &&
      looksLikeSwiggySessionJson(rawText) &&
      (!state || !['waiting_json_login', 'waiting_account_json_login'].includes(state.action))
    ) {
      delete userWaitState[userId];
      const res = await ingestAndPersistRawAccountTexts([{ fileName: 'pasted_session.json', text: rawText }]);
      await sendSafeHtml(ctx, formatBulkVaultImportSummaryHtml(res, 1), getBossReplyKeyboard());
      return;
    }

    // Telegram callback-based edit prompts stay attached to their order; do not allocate a new one.
    if (state && ['waiting_boss_order_cart', 'waiting_boss_order_address', 'waiting_boss_order_mobile'].includes(state.action)) {
      if (rawText.startsWith('/') || ['Cancel', 'cancel', 'Close', 'close', 'Order Screen', 'Main Menu', 'Menu', 'Back', 'back'].includes(rawText)) {
        // The normal menu/cancel handling below clears the pending prompt.
      } else {
        const order = getDb().orders?.[state.orderId];
        if (!order) {
          delete userWaitState[userId];
          await ctx.reply('Order not found; the input prompt has been cleared.');
          return;
        }

        const links = extractAllLinks(rawText);
        if (state.action === 'waiting_boss_order_cart') {
          const parsedCart = parseCartDetails(rawText);
          if (!links.some(isValidSwiggyCartUrl) && !parsedCart) {
            await ctx.reply('! Send a genuine Swiggy Cart / Group Cart link or a readable Swiggy cart receipt.');
            return;
          }
        } else if (state.action === 'waiting_boss_order_mobile') {
          if (!/^(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?[6-9]\d{4}[\s-]?\d{5}$/.test(rawText.trim()) || !normalizeDeliveryContact(rawText)) {
            await ctx.reply('! Send only the recipient’s valid 10-digit Indian mobile number, optionally with +91.');
            return;
          }
        } else {
          const hasAddressLink = links.some(isValidDeliveryAddressUrl);
          const hasMapLink = links.some(link => /maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps/i.test(link));
          const addressDetails = parseAddressDetails(rawText);
          const hasPlausibleStreetAddress = rawText.length >= 20 && /[\p{L}]/u.test(rawText) &&
            ((rawText.match(/,/g) || []).length >= 2 || /\b\d{6}\b/.test(rawText) || /address|latitude|delivery/i.test(rawText));
          const onlyCartLinks = links.length > 0 && links.every(isValidSwiggyCartUrl) && !hasAddressLink && !hasMapLink;
          if (onlyCartLinks || (!hasAddressLink && !hasMapLink && !addressDetails?.address && !hasPlausibleStreetAddress)) {
            await ctx.reply('! Send a delivery address share/link, Google Maps URL, or a full street address with area, city and PIN.');
            return;
          }
        }

        let update;
        try {
          update = await applyBossOrderUpdate({
            telegram: ctx.telegram,
            bossChatId: ctx.chat.id,
            orderId: state.orderId,
            cart: state.action === 'waiting_boss_order_cart' ? rawText : '',
            address: ['waiting_boss_order_address', 'waiting_boss_order_mobile'].includes(state.action) ? rawText : '',
            formatOrderBodyFn: formatUserOrderCardText
          });
        } catch (e) {
          console.error('[boss_order_edit] apply failed:', e?.message||e);
          await ctx.reply(`⛔ Update failed: ${escapeHtml(e?.message||'unknown error')}`).catch(()=>{});
          return;
        }
        if (!update.ok) {
          await ctx.reply(`! ${escapeHtml(update.error || 'Could not update the order.')}`).catch(()=>{});
          return;
        }
        delete userWaitState[userId];
        await ctx.reply(`✓ ${escapeHtml(update.message || 'Order details updated.')}`, { parse_mode: 'HTML' }).catch(()=>{});
        return;
      }
    }

    // 1B. ANY Forwarded OR Direct Boss Cart Link / Address / Combined Cart+Address -> NEVER ask for OTP!
    const isExplicitAdminLinkInput = state && ['waiting_swiggy_link', 'waiting_payment_link', 'waiting_tracking'].includes(state.action);
    if (!isExplicitAdminLinkInput && (extractForwardSenderInfo(ctx.message) || looksLikeBossOrderInput(rawText))) {
      delete userWaitState[userId];
      void handleBossForwardedOrderInput(ctx, {
        rawText,
        formatOrderBodyFn: formatUserOrderCardText,
        nonBlockingAutoSync: true
      }).catch(e => console.error('[BossDirectOrFwdOrderIntake]', e));
      return;
    }
  } else {
    // 1C. Non-Boss Customer sending ANY Cart / Address -> clear any stale non-draft wait state immediately (ZERO OTP!)
    if (state && !['waiting_cart', 'waiting_address'].includes(state.action) && looksLikeBossOrderInput(rawText)) {
      delete userWaitState[userId];
      state = undefined;
    }
  }

  // Intercept any menu button, slash command, or cancel keyword to free user from wait state
  const isMenuOrCancel = rawText.startsWith('/') || [
    'Order Screen', 'Pending Orders', 'Login with JSON', 'Login with Number',
    'Connected Accounts', 'Claim Free Cash', 'Set UPI ID',
    '🟠 🛒 Cart Link', '🟢 🛒 Cart ✓', '🟠 Cart Link', '🟢 Cart ✓',
    '🟠 📍 Address Link', '🟢 📍 Address ✓', '🟠 Address Link', '🟢 Address ✓',
    '🚀 Send to Beta', '✖ Cancel Draft', '✖ Cancel Order', '✖ Cancel', '📦 Previous Order',
    'Cancel', 'cancel', 'Close', 'close', 'back', 'Back',
    'Main Menu', 'Menu',
    // Legacy emoji versions:
    '▣ Order Screen', '● Pending Orders', '◈ Login with JSON', '☎ Login with Number',
    '● Connected Accounts', '▣ Claim Free Cash', '● Set UPI ID',
    '× Cancel', '⌂ Main Menu', '× Close'
  ].includes(rawText);

  if (state && isMenuOrCancel) {
    delete userWaitState[userId];
    if (['× Cancel', 'Cancel', 'cancel', 'Close', 'close', 'back', 'Back', '× Close'].includes(rawText)) {
      if (isBoss(userId)) {
        await ctx.reply('× Action cancelled.', getBossReplyKeyboard());
        const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
      } else {
        await ctx.reply('× Action cancelled.', getUserReplyKeyboard());
        const screen = getUserScreen(userId, ctx.from);
        await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
      }
      return;
    }
  }

  if (state?.action === 'waiting_recipient_name' && !isBoss(userId)) {
    const recipientName = rawText.trim().slice(0, 60);
    if (!recipientName || recipientName.length < 2 || /^(cancel|close|back)$/i.test(recipientName)) {
      delete userWaitState[userId];
      await ctx.reply('✖ Naam sahi likhein (jaise: Rahul, Abbu, Sir):', { parse_mode: 'HTML' });
      return;
    }
    const draft = getDraft(userId);
    updateDraft(userId, { recipientName });
    userWaitState[userId] = { action: 'waiting_recipient_mobile' };
    await ctx.reply(
      `✅ <b>${escapeHtml(recipientName)}</b> ke liye order\n\n` +
      '<i>Uska <b>10-digit mobile number</b> bhejein — yeh recipient contact ke liye use hoga. Swiggy ka SMS alag se verify karna hoga:</i>',
      { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: '10-digit mobile number...' } }
    ).catch(() => null);
    return;
  }

  if (state?.action === 'waiting_recipient_mobile' && !isBoss(userId)) {
    const recipientMobile = extractStandaloneMobileNumber(rawText);
    if (recipientMobile) {
      recordUserPhone(userId, recipientMobile);
      const draft = getDraft(userId);
      const addressDetails = { ...(draft.addressDetails || {}), mobile: recipientMobile };
      const recipientName = draft.recipientName || draft.addressDetails?.name || '';
      updateDraft(userId, { addressDetails, recipientMobile, recipientName });
      delete userWaitState[userId];
      const updatedDraft = getDraft(userId);
      await renderUserCard(ctx, userId, { deleteIncoming: true, notice: '✓ Mobile saved' });
      if (!updatedDraft.cart) {
        userWaitState[userId] = { action: 'waiting_cart' };
        await promptForLink(ctx, userId, 'cart');
      }
      return;
    }

    const hasNewAddress = extractAllLinks(rawText).some(link => isValidDeliveryAddressUrl(link)) ||
      Boolean(parseAddressDetails(rawText)?.address) ||
      extractAllLinks(rawText).some(link => isValidSwiggyCartUrl(link)) ||
      Boolean(parseCartDetails(rawText));
    if (hasNewAddress) {
      delete userWaitState[userId];
      state = undefined;
    } else {
      await ctx.reply('📞 Sirf <b>10-digit mobile number</b> bhejein:', { parse_mode: 'HTML' });
      return;
    }
  }

  // Intercept standalone phone number sent by customer anytime in chat
  const standaloneMobile = !isBoss(userId) && (!state || state.action === 'waiting_both_links') ? extractStandaloneMobileNumber(rawText) : null;
  if (standaloneMobile) {
    recordUserPhone(userId, standaloneMobile);
    const draft = getDraft(userId);
    draft.addressDetails = { ...(draft.addressDetails || {}), mobile: standaloneMobile };
    updateDraft(userId, { addressDetails: draft.addressDetails });

    const activeOrder = getActiveUserOrder(userId);
    if (activeOrder && (!activeOrder.status || activeOrder.status === 'PENDING' || activeOrder.cardStage === 'REVIEW')) {
      activeOrder.addressDetails = { ...(activeOrder.addressDetails || {}), mobile: standaloneMobile };
      activeOrder.recipientMobile = standaloneMobile;
      const db = getDb();
      if (db.orders?.[activeOrder.id]) {
        db.orders[activeOrder.id].addressDetails = activeOrder.addressDetails;
        db.orders[activeOrder.id].recipientMobile = standaloneMobile;
        saveDb(db);
      }
    }

    await ctx.reply(
      `📞 <b>Delivery Mobile Number Saved:</b> <code>${standaloneMobile}</code>\n\n` +
      `Delivery partner isi number par call karega. Order for Others enabled hai.`,
      { parse_mode: 'HTML' }
    );
    if (simpleChatForUser(userId)) {
      const screen = getUserScreen(userId, ctx.from);
      await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard }).catch(() => {});
    }
    return;
  }

  // Handle in-flight delete OTP initiation (prevents any accidental login trigger while waiting for Swiggy)
  if (state && state.action === 'initiating_swiggy_delete_otp') {
    return ctx.reply('◷ <i>Swiggy Deletion OTP request process ho rahi hai. Kripya thoda intezaar karein...</i>', { parse_mode: 'HTML' });
  }

  // Handle Delete Account OTP (TOP PRIORITY: MUST BE PROCESSED BEFORE ANY PHONE OR LOGIN DETECTOR)
  if (state && state.action === 'waiting_swiggy_delete_otp') {
    const rawCleanDigits = rawText.replace(/[^0-9]/g, '');

    const rawLower = rawText.trim().toLowerCase();
    if (['cancel', 'exit', 'na', 'skip', 'nahi', 'close'].includes(rawLower)) {
      delete userWaitState[userId];
      return ctx.reply('× <b>Swiggy account deletion cancelled.</b>', { parse_mode: 'HTML', ...getBossPanelKeyboard() });
    }

    const enteredOtp = rawCleanDigits;
    if (enteredOtp.length !== 6) {
      return ctx.reply(
        `! <b>Invalid OTP</b>\n\n› <i>Enter the 6-digit Delete OTP, or type Cancel:</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('⌂ Main Menu', 'boss_panel_home'),
              Markup.button.callback('× Close', 'close_menu')
            ]
          ])
        }
      );
    }

    const waitMsg = await ctx.reply('◷ <i>Verifying Delete OTP with Swiggy and deleting account...</i>', { parse_mode: 'HTML' });
    const key = state.accountKey;
    const phone = state.phone;
    const accName = state.accName;

    // Use dedicated verifyAndDeleteSwiggyAccountViaBridge (NEVER calls login or sms-otp)
    const result = await verifyAndDeleteSwiggyAccountViaBridge(userId, enteredOtp, key).catch(err => ({ success: false, message: err.message }));

    try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

    if (result.success) {
      delete userWaitState[userId];

      // 1. Export session backup BEFORE deletion
      const exportData = exportSessionJson(key) || getDb().config?.accounts?.[key] || null;
      const jsonFormatted = exportData ? JSON.stringify(exportData, null, 2) : '';
      const jsonCompact = exportData ? JSON.stringify(exportData) : '';

      try {
        await deactivateSwiggyAccountViaBridge(userId, key, true).catch(() => {});
      } catch (e) {}

      // 2. Delete all related disk files (session JSON, SMS/OTP logs, debug files)
      const removedFilesCount = cleanupDiskFilesForAccount(phone, key);

      // 3. Purge account and tombstones
      deleteAccount(key, { purgeVault: true, cleanupFiles: true });

      // 4. Deliver backup JSON file directly to user
      if (jsonFormatted) {
        await ctx.replyWithDocument(
          {
            source: Buffer.from(jsonFormatted, 'utf-8'),
            filename: `swiggy_${phone || key}_deleted_backup.json`
          },
          {
            caption: `📁 <b>Backup Session File</b> (Deleted: <code>${escapeHtml(phone)}</code>)`,
            parse_mode: 'HTML'
          }
        ).catch(() => {});
      }

      // 5. Send message with expandable collapsible code block AND dedicated copy button
      const delButtons = [];
      if (jsonCompact) {
        // Native copy_text button: copies directly to clipboard on tap without expanding message!
        delButtons.push([{ text: '📋 Copy Code', copy_text: { text: jsonCompact } }]);
      }
      delButtons.push([
        Markup.button.url('Open official Swiggy', 'https://www.swiggy.com/'),
        Markup.button.callback('Add Another Account', 'send_to_another_number')
      ]);
      delButtons.push([
        Markup.button.callback('Main Menu', 'boss_panel_home')
      ]);

      const codeBlock = jsonFormatted
        ? `\n\n<b>Backup Session Code:</b>\n<blockquote expandable><pre><code>${escapeHtml(jsonFormatted)}</code></pre></blockquote>\n<i>(Neeche "📋 Copy Code" button dabane se bina expand hue code clipboard me copy ho jayega)</i>`
        : '';

      await ctx.reply(
        `<blockquote>✓ <b>SWIGGY ACCOUNT DELETED SUCCESSFULLY</b></blockquote>\n\n` +
        `☎ <b>Number:</b> <code>${escapeHtml(phone)}</code> (${escapeHtml(accName)})\n` +
        `🗑 <b>Cleanup:</b> Purane session JSON aur SMS/OTP files disk se delete kar diye gaye (${removedFilesCount} files removed).\n` +
        `◈ <b>Status:</b> Account Swiggy server aur bot dono se permanently remove ho gaya hai.${codeBlock}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: delButtons
          }
        }
      );
    } else {
      const swiggyText = result.message || 'Invalid or expired OTP';
      if (result.code === 'SWIGGY_SECURITY_CHALLENGE' || result.code === 'SWIGGY_RATE_LIMIT') {
        delete userWaitState[userId];
        await ctx.reply(
          `× <b>${escapeHtml(swiggyText)}</b>\n\n` +
          `The bot did not retry or bypass Swiggy’s security check. Finish deletion in the official settings page, or remove only the saved bot entry.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('Open official Swiggy settings', 'https://www.swiggy.com/my-account/settings')],
              [Markup.button.callback('Remove from Bot DB', `boss_remove_local_${key}`)],
              [Markup.button.callback('Main Menu', 'boss_panel_home')]
            ])
          }
        );
      } else {
        await ctx.reply(
          `× <b>${escapeHtml(swiggyText)}</b>\n<code>${escapeHtml(phone)}</code>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'Copy Number', copy_text: { text: phone } }
                ],
                [
                  { text: 'Resend Delete OTP', callback_data: `boss_swiggy_delete_start_${key}` }
                ],
                [
                  { text: 'Main Menu', callback_data: 'boss_panel_home' },
                  { text: 'Close', callback_data: 'close_menu' }
                ]
              ]
            }
          }
        );
        await ctx.reply('› Enter valid Delete OTP:', {
          reply_markup: {
            force_reply: true,
            input_field_placeholder: 'Enter 6-digit Delete OTP...'
          }
        });
      }
    }
    return;
  }

  // 0: Check if Boss is typing a new account name
  // Boss apna asli payment UPI set kar raha hai (invalid/placeholder reject).
  if (isBoss(userId) && state && state.action === 'waiting_boss_upi') {
    delete userWaitState[userId];
    const candidate = String(rawText || '').trim().split(/\s+/)[0] || '';
    if (isPlaceholderUpiId(candidate)) {
      return ctx.reply(
        `× <code>${escapeHtml(candidate)}</code> placeholder/Swiggy ID hai — isse bana QR scan par <b>invalid</b> aata hai.\n` +
        `Apni asli UPI bhejein: <code>/setupi yourname@okaxis</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    if (!isValidUpiVpa(candidate)) {
      return ctx.reply(`× <code>${escapeHtml(candidate)}</code> valid UPI ID nahi hai. Format: <code>name@bank</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }
    const upiDb = getDb();
    upiDb.config.bossUpiId = candidate;
    upiDb.config.bossUpiUpdatedAt = new Date().toISOString();
    saveDb(upiDb);
    // Wahi panel wapas — boss ko turant dikhe ki paisa kahan aayega.
    return sendPaymentUpiPanel(ctx, {
      notice: `✓ <b>UPI SAVE HO GAYA:</b> <code>${escapeHtml(candidate)}</code>\n` +
        `<i>Ab order QR ka fallback aur ₹${walletRupees(feePaiseNow())} verification — dono isi UPI par.</i>`
    }).catch(() => {});
  }

  if (state && state.action === 'waiting_new_acc_name') {
    const curDb = getDb();
    const accountsObj = curDb.config?.accounts || {};
    // Prune any abandoned empty unlogged placeholder matching this exact name so Boss is never blocked by a stale cancelled slot!
    const normWanted = String(rawText || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN');
    for (const [k, a] of Object.entries(accountsObj)) {
      const aNorm = String(a?.name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-IN');
      if (aNorm === normWanted && !isAccountLoggedInSession(a) && !a?.phone) {
        deleteAccount(k, { purgeVault: false, skipImmediateCloudPush: true });
      }
    }

    const identity = prepareNewSwiggyAccountIdentity(rawText, getDb().config?.accounts || {});
    if (!identity.success) {
      await ctx.reply(
        `! <b>Account name not accepted:</b> ${escapeHtml(identity.error)}\n› Enter a distinct name:`,
        { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' } }
      );
      return;
    }
    const { name: accName, key: cleanKey } = identity;
    const orderId = state.orderId;
    delete userWaitState[userId];

    createAccount(cleanKey, accName);
    await ctx.reply(
      `✓ <b>Account "${escapeHtml(accName)}" created.</b>\n\n` +
      `Choose how to connect it to Swiggy:`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Phone Number + OTP', `boss_login_acc_otp_${cleanKey}${orderId ? '_' + orderId : ''}`)],
          [Markup.button.callback('Paste Session JSON', `boss_login_acc_json_${cleanKey}${orderId ? '_' + orderId : ''}`)],
          [Markup.button.callback('× Cancel', 'cancel_otp_login')]
        ])
      }
    );
    return;
  }

  // 0B: Check if Boss is typing a new account name for phone login
  if (state && state.action === 'waiting_new_acc_name_for_fast_otp') {
    const identity = prepareNewSwiggyAccountIdentity(rawText, getDb().config?.accounts || {});
    if (!identity.success) {
      await ctx.reply(
        `! <b>Account name not accepted:</b> ${escapeHtml(identity.error)}\n› Enter a distinct name:`,
        { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' } }
      );
      return;
    }
    const { name: accName, key: cleanKey } = identity;
    const phone = normalizeIndianMobileNumber(state.phone);
    if (!phone) {
      delete userWaitState[userId];
      await ctx.reply('× Invalid phone number. Start the login again with a standalone 10-digit number or a 12-digit number beginning with 91.');
      return;
    }
    const duplicatePhone = Object.entries(getDb().config?.accounts || {}).find(([, account]) =>
      normalizeIndianMobileNumber(account?.phone || account?.mobile) === phone
    );
    if (duplicatePhone) {
      delete userWaitState[userId];
      const [existingKey, existingAccount] = duplicatePhone;
      await ctx.reply(
        `! This number is already saved as <b>${escapeHtml(existingAccount.name || existingKey)}</b>. Use that account instead of creating a duplicate.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('Log in to existing account', `boss_login_acc_otp_${existingKey}`)]]) }
      );
      return;
    }

    delete userWaitState[userId];
    createAccount(cleanKey, accName, phone);
    const result = await requestSwiggyOtpViaBridge(userId, phone, cleanKey, accName);
    if (result.success) {
      userWaitState[userId] = { action: 'waiting_swiggy_otp_bridge', targetAcc: cleanKey, phone, name: accName, isNewUser: Boolean(result.isNewUser) };
      await ctx.reply(
        otpSentCard(phone, [`◉ <b>Account:</b> ${escapeHtml(accName)}`, `› <i>6-digit OTP yahan type karein:</i>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phone } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phone}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${phone}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
    return;
  }

  // 0C: Check if Boss is typing a new account name for JSON import
  if (state && state.action === 'waiting_new_acc_name_for_json') {
    const identity = prepareNewSwiggyAccountIdentity(rawText, getDb().config?.accounts || {});
    if (!identity.success) {
      await ctx.reply(
        `! <b>Account name not accepted:</b> ${escapeHtml(identity.error)}\n› Enter a distinct name:`,
        { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Account name (e.g. Bhai)...' } }
      );
      return;
    }
    const { name: accName, key: cleanKey } = identity;
    const pendingJson = state.pendingJson;
    delete userWaitState[userId];

    createAccount(cleanKey, accName);
    const result = importSessionJson(pendingJson, cleanKey);
    if (result.success) {
      await ctx.reply(
        `✓ <b>Account "${escapeHtml(accName)}" created and session imported.</b>\n` +
        `Phone: <code>${escapeHtml(result.phone || '')}</code>\n` +
        `Account is ● Logged In and ready for orders!`,
        { parse_mode: 'HTML', ...getBossPanelKeyboard() }
      );
    } else {
      await ctx.reply(`× Import error: ${result.message}`);
    }
    return;
  }

  // Free Cash JSON / Cookies claim runner
  if (state && state.action === 'waiting_fc_json') {
    delete userWaitState[userId];
    const textTrimmed = rawText.trim();
    let cookies = null;
    let sessionName = 'Pasted Session';

    try {
      if (textTrimmed.startsWith('{') || textTrimmed.startsWith('[')) {
        const parsed = JSON.parse(textTrimmed);
        if (Array.isArray(parsed)) {
          cookies = parsed;
          sessionName = 'Cookie Array JSON';
        } else if (typeof parsed === 'object' && parsed !== null) {
          cookies = parsed.cookies || (parsed.tid ? `tid=${parsed.tid}; _sid=${parsed.sid || ''}; _session_id=${parsed._session_id || ''}` : null);
          if (parsed.phone || parsed.mobile) {
            sessionName = `Phone: ${parsed.phone || parsed.mobile}`;
          }
        }
      }
    } catch (e) {}

    if (!cookies && (textTrimmed.includes('=') || textTrimmed.includes('tid') || textTrimmed.includes('_session_id'))) {
      cookies = textTrimmed;
      sessionName = 'Raw Cookie String';
    }

    if (!cookies) {
      return ctx.reply('! Invalid format. Kripya valid Swiggy session JSON ya cookies string paste karein.');
    }

    const statusMsg = await ctx.reply('◷ <i>Swiggy Instamart claim engine run ho raha hai... (Checking & Claiming)...</i>', { parse_mode: 'HTML' });
    const res = await claimInstamartFreeCash(cookies);

    if (res.status === 'CLAIMED') {
      const successText = `✓ <b>SUCCESSFULLY CLAIMED!</b> ♥\n\n` +
        `◉ <b>Session:</b> ${sessionName}\n` +
        `₹ <b>Claimed Free Cash:</b> <b>₹${res.amount}</b> (Swiggy Money Added!)\n` +
        `₹ <b>Current Total Balance:</b> <b>₹${res.balance}</b>\n` +
        `▣ <b>Instamart Freebie:</b> UNLOCKED ✓ (Eligible on orders above ₹199!)\n` +
        (res.swiggyOne ? `★ <b>Swiggy One:</b> Active (Free Delivery Included)\n` : `↗ <b>Delivery:</b> Free delivery on Instamart\n`) +
        `\n<i>Mubarak ho! Bot ne account run karke Free Cash claim kar liya hai. Aap is session ko connected accounts me save karke Instamart order place kar sakte hain!</i>`;

      const buttons = [
        [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
        [Markup.button.callback('▣ Save as Connected Account', 'boss_add_new_account_menu')],
        [Markup.button.callback('↻ Claim Another Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(successText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } else if (res.status === 'ALREADY_CLAIMED') {
      const alreadyText = `i <b>ALREADY CLAIMED!</b>\n\n` +
        `◉ <b>Session:</b> ${sessionName}\n` +
        `! <b>Status:</b> Is account par Free Cash pehle se claim ho chuka hai.\n` +
        `₹ <b>Available Balance:</b> <b>₹${res.balance}</b>\n\n` +
        `<i>Yeh balance aapke account me already maujood hai. Aap isse Instamart checkout par use kar sakte hain!</i>`;

      const buttons = [
        [Markup.button.url('▤ Open Swiggy Instamart', 'https://www.swiggy.com/instamart')],
        [Markup.button.callback('▣ Save as Connected Account', 'boss_add_new_account_menu')],
        [Markup.button.callback('↻ Claim Another Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(alreadyText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } else {
      const notEligibleText = `× <b>NOT ELIGIBLE FOR FREE CASH</b>\n\n` +
        `◉ <b>Session:</b> ${sessionName}\n` +
        `₹ <b>Free Cash Balance:</b> ₹0\n\n` +
        `<i>Yeh account is promotional Free Cash offer ke liye eligible nahi hai.\n` +
        `Note: Promo offers Swiggy ke naye accounts ya targeted users ke liye aate hain. Aap dusra JSON try karein!</i>`;

      const buttons = [
        [Markup.button.callback('↻ Try Another JSON / Account', 'boss_claim_freecash')]
      ];
      await ctx.reply(notEligibleText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    }

    try {
      await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}
    return;
  }

  // A: Login with JSON / Cookie / Multi-Account Array / Telegram Split-Message Reassembly (>4096 chars!)
  if (splitJsonChunks[userId]) {
    clearTimeout(splitJsonChunks[userId].timer);
    const combined = splitJsonChunks[userId].buf + rawText;
    const extractedCombined = extractSwiggyAccountsListFromInput(combined);
    if (extractedCombined.length > 0) {
      delete splitJsonChunks[userId];
      await handleProcessJsonLogin(ctx, combined, userId);
      return;
    }
    splitJsonChunks[userId].buf = combined;
    splitJsonChunks[userId].timer = setTimeout(() => {
      const leftover = splitJsonChunks[userId]?.buf || '';
      delete splitJsonChunks[userId];
      if (leftover) handleProcessJsonLogin(ctx, leftover, userId).catch(() => {});
    }, 1800);
    return;
  }

  const looksLikeSessionPaste =
    (state && (state.action === 'waiting_json_login' || state.action === 'waiting_json_import')) ||
    ((rawText.startsWith('{') || rawText.startsWith('[') || rawText.startsWith('```') || rawText.includes('_session_tid=')) &&
      /(_session_tid|session_tid|"tid"|"token"|"auth_token"|"access_token"|"cookies"|tid=)/i.test(rawText));

  if (looksLikeSessionPaste) {
    const quickExtracted = extractSwiggyAccountsListFromInput(rawText);
    if (quickExtracted.length > 0) {
      await handleProcessJsonLogin(ctx, rawText, userId);
      return;
    }
    // If Telegram truncated a >4096-char pasted JSON across 2–3 messages, buffer chunk #1 cleanly for 1.8s!
    if ((rawText.startsWith('{') || rawText.startsWith('[') || rawText.startsWith('```')) && rawText.length >= 3500) {
      splitJsonChunks[userId] = {
        buf: rawText,
        timer: setTimeout(() => {
          const leftover = splitJsonChunks[userId]?.buf || '';
          delete splitJsonChunks[userId];
          if (leftover) handleProcessJsonLogin(ctx, leftover, userId).catch(() => {});
        }, 1800)
      };
      return;
    }
    if (state && (state.action === 'waiting_json_login' || state.action === 'waiting_json_import')) {
      return ctx.reply('! Invalid JSON format. Kripya valid Swiggy session JSON, Cookie string, ya .json/.txt file bhejein.');
    }
  }

  // Helper for starting phone number login
  async function triggerPhoneNumberLogin(phoneToLogin, existingAccKey, existingAccName) {
    const pendingOrderId = state?.orderId || null;
    const matchedKey = existingAccKey || findAccountKeyByPhone(getDb().config?.accounts || {}, phoneToLogin) || `acc_${phoneToLogin}`;
    const cleanName = (existingAccName && existingAccName.trim().length >= 2 && !/^user\s*\d*$/i.test(existingAccName.trim()))
      ? existingAccName.trim()
      : null;
    const autoName = cleanName || getDb().config?.accounts?.[matchedKey]?.name || getNextAutoUserName();
    delete userWaitState[userId];

    const result = await requestSwiggyOtpViaBridge(userId, phoneToLogin, matchedKey, autoName);

    if (result.needsName) {
      userWaitState[userId] = {
        action: 'waiting_name_for_new_number_signup',
        phone: phoneToLogin,
        targetAcc: matchedKey,
        orderId: pendingOrderId
      };

      await ctx.reply('› Enter Name:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter Name...'
        }
      });
      return;
    }

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: matchedKey,
        phone: phoneToLogin,
        name: autoName,
        orderId: pendingOrderId,
        isNewUser: Boolean(result.isNewUser)
      };

      await ctx.reply(
        otpSentCard(phoneToLogin, [`› <i>6-digit OTP yahan type karein:</i>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: phoneToLogin } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${phoneToLogin}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${phoneToLogin}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      const errCard = formatOtpSendErrorCard(phoneToLogin, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
  }

  // B: Login with Number - Phone Input
  if (state && (state.action === 'waiting_phone_for_number_login' || state.action === 'waiting_phone_for_new_acc_order')) {
    const cleanPhone = extractStandaloneMobileNumber(rawText);
    if (!cleanPhone) {
      await ctx.reply(
        'Send only a standalone 10-digit number or a 12-digit number beginning with 91.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Main Menu', callback_data: 'boss_panel_home' },
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter Mobile Number:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: '10 digits, or 91 + 10 digits...'
        }
      });
      return;
    }

    const db = getDb();
    const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === cleanPhone);
    const existingKey = existing ? existing[0] : null;
    const existingName = existing ? (existing[1]?.name || existing[0]) : null;

    await triggerPhoneNumberLogin(cleanPhone, existingKey, existingName);
    return;
  }

  // Handle Name for New Swiggy Account Registration (Prompted after OTP verification)
  if (state && (state.action === 'waiting_swiggy_new_account_name' || state.action === 'waiting_name_for_new_swiggy_signup')) {
    await completeNewAccountWithChosenName(ctx, userId, rawText);
    return;
  }

  // Handle Name for New Swiggy Number Signup
  if (state && state.action === 'waiting_name_for_new_number_signup') {
    const enteredName = rawText.trim();
    if (!enteredName || enteredName.length < 2 || /^\d+$/.test(enteredName)) {
      await ctx.reply('› Enter Name:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter Name...'
        }
      });
      return;
    }
    const phone = state.phone;
    delete userWaitState[userId];
    await triggerPhoneNumberLogin(phone, `acc_${phone}`, enteredName);
    return;
  }

  // D: Fast Standalone 10-Digit Mobile Number Detection (ONLY bare phone numbers — NEVER URLs, Carts, or Addresses!)
  const cleanPhoneInput = extractStandaloneMobileNumber(rawText);
  if (isBoss(userId) && (!state || !state.action) && cleanPhoneInput) {
    const db = getDb();
    const existing = Object.entries(db.config?.accounts || {}).find(([k, a]) => normalizeIndianMobileNumber(a.phone || a.mobile || k.replace(/^acc_/, '')) === cleanPhoneInput);
    const existingKey = existing ? existing[0] : null;
    const existingName = existing ? (existing[1]?.name || existing[0]) : null;

    await triggerPhoneNumberLogin(cleanPhoneInput, existingKey, existingName);
    return;
  }

  // Step 1: User entered a standalone 10-digit number or 12-digit +91 number for Swiggy login.
  if (state && state.action === 'waiting_phone_for_otp') {
    const targetAcc = state.targetAcc;
    const pendingOrderId = state.orderId || null;
    const cleanPhone = extractStandaloneMobileNumber(rawText);

    if (!cleanPhone) {
      await ctx.reply('Send only a standalone 10-digit number or a 12-digit number beginning with 91.');
      await ctx.reply('› Enter Mobile Number:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: '10 digits, or 91 + 10 digits...'
        }
      });
      return;
    }

    const dbSnapshot = getDb();
    const existingTarget = dbSnapshot.config?.accounts?.[targetAcc];
    const autoName = existingTarget?.name || getNextAutoUserName();
    createAccount(targetAcc, autoName, cleanPhone);
    const result = await requestSwiggyOtpViaBridge(userId, cleanPhone, targetAcc, autoName);

    if (result.success) {
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc,
        phone: cleanPhone,
        name: autoName,
        orderId: pendingOrderId,
        isNewUser: Boolean(result.isNewUser)
      };

      await ctx.reply(
        otpSentCard(cleanPhone, [`› <i>6-digit OTP yahan type karein:</i>`]),
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: cleanPhone } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${cleanPhone}` },
                { text: 'Resend OTP', callback_data: `resend_otp_${cleanPhone}` }
              ],
              [
                { text: 'Another Number', callback_data: 'send_to_another_number' },
                { text: 'Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: 'Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    } else {
      delete userWaitState[userId];
      // If `targetAcc` was a newly created empty slot that never logged in, don't leave a dead orphan slot with wrong/blocked phone!
      const curAcc = getDb().config?.accounts?.[targetAcc];
      if (curAcc && !isAccountLoggedInSession(curAcc) && targetAcc !== `acc_${cleanPhone}`) {
        curAcc.phone = '';
        curAcc.mobile = '';
        const d2 = getDb();
        if (d2.config?.accounts?.[targetAcc] && !isAccountLoggedInSession(d2.config.accounts[targetAcc])) {
          d2.config.accounts[targetAcc].phone = '';
          d2.config.accounts[targetAcc].mobile = '';
          saveDb(d2);
        }
      }
      const errCard = formatOtpSendErrorCard(cleanPhone, result);
      await ctx.reply(errCard.text, {
        parse_mode: 'HTML',
        ...errCard.keyboard
      });
    }
    return;
  }

  // Step 2: User enters 6-digit OTP
  if (state && state.action === 'waiting_swiggy_otp_bridge') {
    // Switch only when the entire message is a standalone valid 10-digit or +91-prefixed phone number.
    const phoneSwitch = extractStandaloneMobileNumber(rawText);
    if (phoneSwitch) {
      delete userWaitState[userId];
      const db = getDb();
      const existingKey = findAccountKeyByPhone(db.config?.accounts || {}, phoneSwitch);
      const existingName = existingKey ? (db.config.accounts[existingKey]?.name || existingKey) : null;

      await ctx.reply(`Switching to number ${phoneSwitch}...`);
      await triggerPhoneNumberLogin(phoneSwitch, existingKey, existingName);
      return;
    }

    const rawLower = rawText.trim().toLowerCase();
    if (['cancel', 'exit', 'na', 'skip', 'nahi', 'nahi aaya', 'doosra', 'close', 'another', 'change'].includes(rawLower)) {
      return promptBossLoginWithNumber(ctx);
    }

    // Safely extract 6-digit OTP without ever mistaking URLs (`swiggy.com/menu/123456`) or JSONs for an OTP!
    let enteredOtp = '';
    if (!/https?:\/\/|swig\.gy|swiggy\.com|goo\.gl|maps|[{[\]}]/i.test(rawText)) {
      const directOtp = extractStandaloneOtpDigits(rawText);
      if (directOtp && directOtp.length === 6) {
        enteredOtp = directOtp;
      } else {
        const spacedDigits = rawText.trim().match(/^(\d{3})[\s-]+(\d{3})$/);
        if (spacedDigits) {
          enteredOtp = `${spacedDigits[1]}${spacedDigits[2]}`;
        } else {
          const smsCodeMatch = rawText.match(/(?<!\d)(\d{6})(?!\d)/);
          if (smsCodeMatch) enteredOtp = smsCodeMatch[1];
        }
      }
    }

    if (enteredOtp.length !== 6) {
      await ctx.reply(
        `! <b>Exact 6-digit Swiggy OTP enter karein</b>\n☎ <code>${state.phone}</code>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Copy Number', copy_text: { text: state.phone } }
              ],
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${state.phone}` },
                { text: '✉ Resend OTP', callback_data: `resend_otp_${state.phone}` }
              ],
              [
                { text: '☎ Another Number', callback_data: 'send_to_another_number' },
                { text: '⌂ Main Menu', callback_data: 'boss_panel_home' }
              ],
              [
                { text: '× Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Enter 6-digit OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
      return;
    }

    const result = await verifySwiggyOtpViaBridge(userId, enteredOtp);

    const isBrandNewAccount = Boolean(
      result.wasNewSignup ||
      result.isNewUser ||
      result.needsSignup ||
      state.isNewUser
    );

    // If it's a brand-new Swiggy account registration, ask the user for their desired account name!
    if (isBrandNewAccount && (result.success || result.isNewUser || result.needsSignup)) {
      const orderId = state.orderId;
      const effectiveKey = result.accountKey || state.targetAcc || `acc_${state.phone}`;
      userWaitState[userId] = {
        action: 'waiting_swiggy_new_account_name',
        phone: state.phone,
        targetAcc: effectiveKey,
        savedSessionKey: effectiveKey,
        orderId,
        verifyResult: result.success ? result : null,
        needsSignupCall: Boolean(!result.success && (result.isNewUser || result.needsSignup)),
        existingName: state.name || null
      };

      const keyboardButtons = [];
      if (state.name && !/^user\s*\d*$/i.test(state.name) && !/rahul kumar/i.test(state.name)) {
        keyboardButtons.push([
          { text: `⚡ Keep "${state.name}"`, callback_data: `keep_new_acc_name_${state.phone}` }
        ]);
      }
      keyboardButtons.push([
        { text: '⚡ Auto Assign (User)', callback_data: `auto_assign_new_name_${state.phone}` }
      ]);
      keyboardButtons.push([
        { text: '⌂ Main Menu', callback_data: 'boss_panel_home' },
        { text: '× Close', callback_data: 'close_menu' }
      ]);

      await ctx.reply(
        `🎉 <b>Naya Swiggy Account Detect Hua!</b>\n` +
        `☎ <b>Mobile:</b> <code>${escapeHtml(state.phone)}</code>\n` +
        `✓ <b>OTP Verified Successfully!</b>\n\n` +
        `› <b>Is account ka kya naam rakhna chahte hain?</b>\n` +
        `Apna naam ya custom slot label type karke bhejein (jaise: <code>Rahul</code>, <code>Aman</code>, <code>Bhai</code>, <code>Slot 5</code>):`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: keyboardButtons
          }
        }
      );
      await ctx.reply('› Enter Account Name:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter Account Name (e.g. Aman, Rahul)...'
        }
      });
      return;
    }

    if (result.success) {
      const orderId = state.orderId;
      delete userWaitState[userId];
      syncCloudVaultNow(getDb()).catch(() => {});
      await sendAccountLoginAndOffersCard(ctx, result, userId, orderId);
      return;
    }

    if (result.isNewUser || result.needsSignup) {
      const autoName = state.name || getNextAutoUserName();
      const signupRes = await signupSwiggyViaBridge(userId, autoName);
      if (signupRes.success) {
        const orderId = state.orderId;
        delete userWaitState[userId];
        syncCloudVaultNow(getDb()).catch(() => {});
        await sendAccountLoginAndOffersCard(ctx, signupRes, userId, orderId);
      } else {
        await ctx.reply(`<blockquote>${escapeHtml(signupRes.message)}</blockquote>`, { parse_mode: 'HTML', ...getBossPanelKeyboard() });
      }
      return;
    }

    if (['SWIGGY_SECURITY_CHALLENGE', 'SWIGGY_RATE_LIMIT'].includes(result.code)) {
      delete userWaitState[userId];
      const challenge = result.code === 'SWIGGY_SECURITY_CHALLENGE';
      const title = challenge ? 'Swiggy Security Check Blocked Login' : 'Swiggy OTP Limit Reached';
      const reason = result.message || result.swiggyStatus || 'Swiggy stopped this verification.';
      const text = section(title, [
        `☎ <b>Number:</b> <code>${escapeHtml(state.phone)}</code>`,
        `! <b>Swiggy response:</b>`,
        `<blockquote>${escapeHtml(reason)}</blockquote>`,
        `› <i>This bot will not retry or bypass Swiggy security checks. Use the official Swiggy app/site, or import an existing valid session.</i>`
      ].join('\n'));
      await ctx.reply(text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('Open official Swiggy', 'https://www.swiggy.com/')],
          [Markup.button.callback('Paste Session JSON', 'boss_login_with_json'), Markup.button.callback('Main Menu', 'boss_panel_home')]
        ])
      });
    } else {
      const swiggyText = result.swiggyStatus || result.message || 'Galat ya expired OTP';
      userWaitState[userId] = {
        action: 'waiting_swiggy_otp_bridge',
        targetAcc: state.targetAcc,
        phone: state.phone,
        name: state.name,
        orderId: state.orderId,
        isNewUser: Boolean(state.isNewUser)
      };
      await ctx.reply(
        `× <b>Galat OTP / Verification Failed!</b>\n` +
        `☎ <b>Number:</b> <code>${state.phone}</code>\n\n` +
        `! <b>Swiggy Response:</b>\n` +
        `<blockquote>${escapeHtml(swiggyText)}</blockquote>\n` +
        `› <i>Sahi 6-digit OTP dubara type karein ya neeche <b>Re-enter OTP</b> dabayein:</i>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '↻ Re-enter OTP', callback_data: `prompt_reenter_otp_${state.phone}` },
                { text: '✉ Resend New OTP', callback_data: `resend_otp_${state.phone}` }
              ],
              [
                { text: '☎ Another Number', callback_data: 'send_to_another_number' },
                { text: '▤ Session JSON', callback_data: 'boss_login_with_json' }
              ],
              [
                { text: '⌂ Main Menu', callback_data: 'boss_panel_home' },
                { text: '× Close', callback_data: 'close_menu' }
              ]
            ]
          }
        }
      );
      await ctx.reply('› Re-enter 6-digit OTP:', {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Enter 6-digit OTP...'
        }
      });
    }
    return;
  }



  // Boss sending text to user
  if (state && state.action === 'waiting_text_user') {
    const targetUserId = state.targetUserId;
    const orderId = state.orderId;
    delete userWaitState[userId];

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        `✉ <b>Beta ka sandesh (Order #${orderId}):</b>\n\n${escapeHtml(rawText)}`,
        { parse_mode: 'HTML' }
      );
      await ctx.reply(`✓ <b>Message delivered to user!</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`× Failed to send message: ${err.message}`);
    }
    return;
  }

  // Boss sending official Swiggy payment link to user
  if (state && (state.action === 'waiting_swiggy_link' || state.action === 'waiting_payment_link')) {
    const orderId = state.orderId;
    delete userWaitState[userId];
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) {
      await ctx.reply('× Order could not be found.');
      return;
    }

    // Only the link is meaningful; markdown wrappers and the note around it are dropped.
    const pastedUrls = extractSharedUrls(rawText);
    let link = pastedUrls[0] || stripSharedLinks(rawText);
    const amtMatch = rawText.match(/(?:₹|rs\.?|inr)?\s*([0-9]{2,5})\b/i);

    if (pastedUrls.length > 0) {
      link = pastedUrls[0];
      if (amtMatch && !link.includes(amtMatch[1])) {
        order.finalPayable = parseInt(amtMatch[1], 10);
      }
    }

    order.swiggyPaymentUrl = link;
    order.paymentStatus = 'PAYMENT_LINK_SENT';
    saveDb(db);
    await updateOrderCards(order);

    const targetUserId = order.userChatId || order.userId;
    if (targetUserId) {
      try {
        const amtText = order.finalPayable ? `\n₹ <b>Payable on Swiggy:</b> ₹${order.finalPayable}` : '';
        await bot.telegram.sendMessage(
          targetUserId,
          `₹ <b>Official Swiggy Payment Link Ready! (Order #${orderId})</b>\n\n` +
          `▣ <b>Restaurant:</b> ${escapeHtml(order.restaurantName || 'Swiggy Order')}${amtText}\n\n` +
          `↗ <b>Click to Pay Directly on Swiggy:</b>\n<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>\n\n` +
          `<i>★ Yeh authentic link Swiggy payment page se generated hai. Payment ke baad [ Check payment status ] dabayein!</i>`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.url('₹ Pay on Swiggy (Official Link)', link)],
              [Markup.button.callback('Check payment status', `user_paid_status_${orderId}`)],
              [Markup.button.url('✉ Contact Support (@Its_life_001)', 'https://t.me/Its_life_001')]
            ])
          }
        );
        await ctx.reply(`✓ <b>Official Swiggy Payment Link delivered to Customer!</b>\n\nLink: <code>${escapeHtml(link)}</code>`, { parse_mode: 'HTML' });
      } catch (err) {
        await ctx.reply(`× Failed to send link to user: ${err.message}`);
      }
    }
    return;
  }

  // Boss setting custom amount
  if (state && state.action === 'waiting_set_amount') {
    const orderId = state.orderId;
    delete userWaitState[userId];

    const num = parseInt(rawText.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(num) && num > 0) {
      const db = getDb();
      const order = db.orders[orderId];
      if (order) {
        order.finalPayable = num;
        order.amountAccepted = false; // User must accept the newly set amount!
        saveDb(db);
        await updateOrderCards(order);
        await ctx.reply(`✓ <b>Payable amount updated to ₹${num}! User ke card par [ Accept Order ] update ho gaya hai.</b>`, { parse_mode: 'HTML' });
      }
    } else {
      await ctx.reply(`! Invalid amount. Please enter a valid number.`);
    }
    return;
  }

  // Boss setting custom coupon code
  if (state && state.action === 'waiting_set_coupon') {
    const orderId = state.orderId;
    delete userWaitState[userId];
    const code = rawText.trim().toUpperCase();
    const db = getDb();
    const order = db.orders[orderId];
    if (!order) {
      await ctx.reply('× Order not found.');
      return;
    }

    const selAcc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;

    if (code === 'REMOVE' || code === 'NONE' || code === 'CLEAR' || code === '0') {
      const liveRemoved = selAcc?.cookies ? await applyLiveCouponToOrder(selAcc, order, 'REMOVE').catch(() => null) : null;
      order.couponCode = null;
      order.discountAmount = 0;
      if (liveRemoved && liveRemoved.items?.length > 0) {
        order.finalPayable = liveRemoved.finalPayable;
        order.totalSavings = liveRemoved.totalSavings;
        order.swiggyVerified = true;
      } else {
        order.swiggyVerified = false;
        applyMaxOfferToOrder(order);
      }
      saveDb(db);
      await updateOrderCards(order);
      await ctx.reply(`✓ <b>Coupon removed from Order #${orderId}!</b>\nNew Payable: ₹${order.finalPayable}`, { parse_mode: 'HTML' });
      return;
    }

    const liveApplied = selAcc?.cookies ? await applyLiveCouponToOrder(selAcc, order, code).catch(() => null) : null;
    if (liveApplied && liveApplied.items?.length > 0) {
      order.couponCode = liveApplied.couponCode || code;
      order.discountAmount = liveApplied.discountAmount || 0;
      order.deliveryFee = liveApplied.deliveryFee || 0;
      order.packingCharges = liveApplied.packingCharges || 0;
      order.taxesAndCharges = liveApplied.taxesAndCharges || 0;
      order.finalPayable = liveApplied.finalPayable;
      order.totalSavings = liveApplied.totalSavings;
      order.swiggyVerified = true;
    } else {
      let appliedDiscount = 0;
      if (code.includes('70')) {
        appliedDiscount = Math.min(100, Math.round((order.subtotal || 200) * 0.7));
      } else if (code.includes('100')) {
        appliedDiscount = 100;
      } else if (code.includes('125')) {
        appliedDiscount = 125;
      } else if (code.includes('150')) {
        appliedDiscount = 150;
      } else if (code.includes('175')) {
        appliedDiscount = 175;
      } else {
        appliedDiscount = 50;
      }

      order.couponCode = code;
      order.discountAmount = appliedDiscount;
      order.swiggyVerified = false;
      applyMaxOfferToOrder(order);
    }

    saveDb(db);
    await updateOrderCards(order);
    await ctx.reply(
      `✓ <b>Coupon "${escapeHtml(order.couponCode || code)}" Applied Successfully to Order #${orderId}!</b>\n\n` +
      `₹ <b>Discount:</b> −₹${order.discountAmount || 0}\n` +
      `₹ <b>New Payable Amount:</b> <b>₹${order.finalPayable}</b>\n\n` +
      `<i>User aur Boss dono ke card par naya amount update ho gaya hai!</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // Boss setting custom UPI ID
  if (state && state.action === 'waiting_set_upi') {
    delete userWaitState[userId];
    const upi = rawText.trim();
    if (upi.includes('@')) {
      const db = getDb();
      db.config.bossUpiId = upi;
      saveDb(db);
      await ctx.reply(`✓ <b>Payment UPI ID saved:</b> <code>${upi}</code>\nAb se sabhi payment QR is UPI ID par generate honge!`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`! Invalid UPI ID format. Should contain '@' (e.g. yourname@paytm).`);
    }
    return;
  }

  // Boss entering a delivery OTP that Swiggy provided outside the live account feed
  if (state && state.action === 'waiting_delivery_otp') {
    const digits = rawText.replace(/\D/g, '');
    if (!/^\d{4,8}$/.test(digits)) {
      await ctx.reply('! Enter only the 4–8 digit delivery OTP that Swiggy provided. Login/payment OTPs are not accepted here.');
      return;
    }
    const orderId = state.orderId;
    const db = getDb();
    const order = db.orders?.[orderId];
    if (!order) {
      delete userWaitState[userId];
      await ctx.reply('! Order not found.');
      return;
    }
    delete userWaitState[userId];
    order.deliveryOtp = digits;
    order.deliveryOtpSource = 'BOSS_PROVIDED';
    saveDb(db);
    await updateOrderCards(order);
    const firstBossChatId = db.config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
    await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId, order, { force: true });
    await ctx.reply(`✓ Delivery OTP saved and sent with the verified Swiggy tracking link when available.`);
    return;
  }

  // Extract Tracking — works for ANY user (boss or customer) : Swiggy order id se direct scan
  if (state && state.action === 'waiting_boss_extract_tracking') {
    const rawText = String(ctx.message.text || '').trim();
    let q = rawText;
    for (const token of rawText.split(/\s+/).filter(Boolean)) {
      const clean = token.replace(/[^A-Za-z0-9_-]/g, '').trim();
      if (/^\d{10,20}$/.test(clean) || /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(clean)) { q = clean; break; }
    }
    q = q.replace(/[^A-Za-z0-9_-]/g, '').trim() || rawText;
    const db2 = getDb();

    // Exact lookup only: order ref, Swiggy id or pending id. A partial numeric
    // suffix is NEVER used (that used to match the wrong order).
    let order = db2.orders?.[q] || db2.orders?.[q.toLowerCase()] || db2.orders?.[q.toUpperCase()] || null;
    if (!order) {
      const qLower = q.toLowerCase();
      for (const candidate of Object.values(db2.orders || {})) {
        if (!candidate) continue;
        const refMatch = String(candidate.id || '').toLowerCase() === qLower;
        const swiggyMatch = [candidate.swiggyOrderId, candidate.pendingSwiggyOrderId]
          .some(value => String(value || '') === q);
        if (refMatch || swiggyMatch) { order = candidate; break; }
      }
    }

    const isNumericSwiggyId = /^\d{10,20}$/.test(q);
    if (!order && !isNumericSwiggyId) {
      const knownIds = Object.values(db2.orders || {})
        .filter(o => o && String(o.id || '').toUpperCase() !== 'TEST')
        .slice(0, 8)
        .map(o => `#${o.id}`)
        .join(', ') || 'none';
      await ctx.reply(
        `❌ <b>Order <code>${escapeHtml(q)}</code> bot DB me nahi mila.</b>\n\n` +
        `▪ Known order refs: <code>${escapeHtml(knownIds)}</code>\n` +
        `<i>Ya exact Swiggy numeric order id (12–18 digits) bhejein — bot usko har logged-in ID par dhoondhega. Koi false id nahi banega.</i>`,
        { parse_mode: 'HTML' }
      );
      delete userWaitState[ctx.from.id];
      return;
    }

    if (!order) {
      // Transient reference — saved only after Swiggy confirms the order exists.
      order = {
        id: q,
        swiggyOrderId: q,
        pendingSwiggyOrderId: q,
        restaurantName: 'Swiggy Order',
        status: 'UNVERIFIED',
        addressDetails: {},
        createdAt: new Date().toISOString(),
        userId: String(ctx.from.id),
        fwdSenderUserId: String(ctx.from.id),
        userName: ctx.from?.first_name || 'Customer',
        fwdSenderName: ctx.from?.first_name || 'Customer',
        selectedAccount: '',
        trackingLink: '',
        trackingLinkSource: '',
        deliveryOtp: '',
        liveOrderStatus: '',
        isSwiggyIdLookup: true
      };
    }

    const statusMsg = await ctx.reply(
      `⏳ <i>Scanning ${Object.keys(db2.config?.accounts || {}).length} Swiggy IDs for <code>${escapeHtml(q)}</code>…</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

    try {
      // IMPORTANT: pass the order OBJECT. Passing `order.id` for a pasted Swiggy
      // id made `findOrderRecord()` return null, so the scan was skipped
      // entirely ("Scanned: 0 IDs") instead of searching all logged-in IDs.
      // INSTANT TRY FIRST: the exact call the Swiggy app makes for this order —
      // `trackV4` -> `fyi_details[].value.cta_link` on the likely account. A
      // pasted Swiggy id usually answers here in ~300ms, so the link comes back
      // immediately instead of after a 29-ID scan.
      let instantUrl = '';
      if (isNumericSwiggyId) {
        const accMap = db2.config?.accounts || {};
        // Stale `sessionExpired` / `isLoggedOut` flags do NOT exclude an ID here:
        // the flags come from an older background call, and Swiggy can still
        // answer on that same session. Only "no credentials at all" is skipped.
        const likelyKeys = [order.selectedAccount, ...Object.keys(accMap)].filter(Boolean)
          .filter((k, i, arr) => arr.indexOf(k) === i)
          .filter((k) => {
            const acc = accMap[k];
            return Boolean(acc && (acc.cookies || acc.tid || acc.jwtTid || acc.token || acc.auth_token || acc.access_token));
          });
        for (const key of likelyKeys.slice(0, 6)) {
          try {
            const fast = await fetchSwiggyTrackingLinkFast(accMap[key], q, { budgetMs: 2500, attempts: 1 });
            if (fast?.url) {
              instantUrl = fast.url;
              order.selectedAccount = order.selectedAccount || key;
              order.orderAccount = order.orderAccount || (accMap[key].phone || key);
              console.log(`[Tracking] Instant link for pasted id ${q} from ${key}`);
              break;
            }
          } catch {}
        }
      }
      if (instantUrl) {
        order.trackingLink = instantUrl;
        order.trackingLinkSource = 'SWIGGY_API';
        order.swiggyOrderId = order.swiggyOrderId || q;
        order.trackingFoundAt = new Date().toISOString();
        const quickDb = getDb();
        quickDb.orders[order.id] = { ...(quickDb.orders[order.id] || {}), ...order };
        saveDb(quickDb);
      }

      const result = instantUrl
        ? { status: 'TRACKING_FOUND', hasOrder: true, scanned: 1 }
        : await ensureOrderTracking(order, {
            force: true,
            budgetMs: isNumericSwiggyId ? 32000 : 20000,
            deep: true,
            // The human is waiting on this exact id: never answer "not found"
            // because a background sweep happened to set a WAF cooldown, and let
            // every ID with credentials be asked (flags can be stale).
            ignoreWafCooldown: isNumericSwiggyId,
            includeStaleFlags: isNumericSwiggyId
          });
      if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }

      if (result?.status === 'WAF_COOLDOWN') {
        const min = Math.max(1, Math.ceil((result.cooldownMs || 0) / 60000));
        await ctx.reply(
          `⏳ <b>Swiggy WAF cooldown — ${min} min bane.</b>\n\n<i>Bot ne saare scans ${min} min ke liye pause kar diye taaki block thanda ho jaye (zyada retry se block aur der tak rehta hai). ${min} min baad <code>${escapeHtml(q)}</code> dobara bhej dena — auto-scan bhi khud resume ho jayega.</i>`,
          { parse_mode: 'HTML' }
        );
        delete userWaitState[ctx.from.id];
        return;
      }

      const fresh = getDb().orders?.[order.id] || order;
      const trackingUrl = getStoredSwiggyTrackingUrl(fresh);
      const swiggyId = swiggyOrderIdOf(fresh) || (isNumericSwiggyId ? q : '');
      const phone = placedFromPhoneOf(fresh, getDb());
      const rawLiveStatus = String(fresh.liveOrderStatus || result?.orderStatus || '');
      const liveStatus = normalizeSwiggyLiveOrderStatus(rawLiveStatus) || rawLiveStatus;

      if (!result?.hasOrder && !trackingUrl) {
        const noAccounts = result?.status === 'NO_ACCOUNTS' || (Number(result?.scanned) || 0) === 0;
        await ctx.reply(
          noAccounts
            ? `⚠️ <b>Koi logged-in Swiggy ID nahi mila</b> — isliye <code>${escapeHtml(q)}</code> scan nahi ho paya.\n\n` +
              `<i>Boss Panel → accounts login karein, phir dobara try karein.</i>`
            : `❌ <b>Swiggy order <code>${escapeHtml(q)}</code> kisi bhi logged-in ID par nahi mila.</b>\n\n` +
              `▪ IDs scanned: <b>${Number(result?.scanned) || 0}</b>${result?.status === 'TIMEOUT' ? ' (time out)' : ''}\n` +
              scanFailuresLine(result) +
              `▪ <b>Order kisi dusre Swiggy account par hoga</b> — jis account se order hua usko is bot me login karo (<b>My Accounts</b>), phir dobara id bhejo.\n` +
              `<i>Order id bhi verify karo (numeric, 12–18 digits) — Swiggy app: Profile → My Orders. Bot koi false link nahi banata.</i>`,
          { parse_mode: 'HTML' }
        );
        delete userWaitState[ctx.from.id];
        return;
      }

      const saveNow = getDb();
      const rec = saveNow.orders?.[order.id] || fresh;
      if (!saveNow.orders?.[order.id]) {
        rec.isExternalOrder = true;
        rec.isSwiggyIdLookup = true;
        saveNow.orders[rec.id] = rec;
      }
      if (rec.status !== 'COMPLETED') {
        rec.status = 'COMPLETED';
        rec.cardStage = 'PAID_CONFIRMED';
        rec.completedAt = rec.completedAt || new Date().toISOString();
      }
      saveDb(saveNow);

      const isCancelledExtract = /cancel|refus|return/i.test(liveStatus);
      const isDeliveredExtract = /deliv/i.test(liveStatus);
      if (trackingUrl) {
        await ctx.reply(
          `✅ <b>Tracking extracted</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          (liveStatus ? `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>\n` : '') +
          `▪ <b>Tracking:</b> <a href="${escapeHtml(trackingUrl)}">Open Swiggy tracking</a>` +
          (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
          (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy Tracking', trackingUrl)]])
          }
        );
      } else if (isCancelledExtract) {
        await ctx.reply(
          `✅ <b>Order Swiggy par mil gaya</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>\n\n` +
          `<i>Order cancel ho chuka hai — iske liye tracking link available nahi hai.</i>`,
          { parse_mode: 'HTML' }
        );
      } else if (isDeliveredExtract) {
        const deliveredExtractUrl = buildSignedOrderTrackUrl(swiggyId || rec.id);
        await ctx.reply(
          `✅ <b>Tracking link ready</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          `▪ <b>Status:</b> <code>${escapeHtml(liveStatus)}</code>` +
          (deliveredExtractUrl ? `\n▪ <b>Tracking:</b> <a href="${escapeHtml(deliveredExtractUrl)}">Open order tracking</a>` : '') +
          (rec.deliveryOtp ? `\n▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(rec.deliveryOtp))}</code>` : '') +
          (rec.deliveryBoyName || rec.deliveryBoyMobile ? `\n▪ <b>Rider:</b> ${escapeHtml([rec.deliveryBoyName, rec.deliveryBoyMobile].filter(Boolean).join(' · '))}` : ''),
          {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...Markup.inlineKeyboard([
              ...(deliveredExtractUrl ? [[Markup.button.url('🔗 Open Order Tracking', deliveredExtractUrl)]] : []),
              [Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]
            ])
          }
        );
      } else {
        await ctx.reply(
          `✅ <b>Order Swiggy par mil gaya</b>\n` +
          `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>\n` +
          `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>\n` +
          `▪ <b>Status:</b> <code>${escapeHtml(liveStatus || 'Order Confirmed')}</code>\n\n` +
          `<i>Share link abhi publish nahi hua — bot background me retry karega aur link aate hi bhej dega.</i>`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Tracking', `extract_now_${rec.id}`)]]) }
        );
        startOrderTrackingAuto(rec.id, { force: true, budgetMs: 12000 });
      }

      if (isBoss(ctx.from.id)) {
        const bossCard = formatBossOrderCard(rec);
        await ctx.reply(bossCard.text, { parse_mode: 'HTML', ...bossCard.keyboard }).catch(() => {});
      }
    } catch (e) {
      if (statusMsg) { try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch {} }
      await ctx.reply(`❌ Failed: ${escapeHtml(String(e?.message || e))}`, { parse_mode: 'HTML' });
    }
    delete userWaitState[ctx.from.id];
    return;
  }

  if (state && state.action === 'waiting_tracking') {
    const orderId = state.orderId;
    const candidateLink = extractAllLinks(rawText).find(isOfficialSwiggyTrackingUrl);
    if (!candidateLink) {
      await ctx.reply('! Please paste the official Swiggy tracking URL. An order ID or rider phone is not a tracking link.');
      return;
    }
    delete userWaitState[userId];

    const db = getDb();
    const order = db.orders[orderId];
    if (!order) return ctx.reply('! Order not found.');

    order.trackingLink = candidateLink;
    order.trackingLinkSource = 'BOSS_PROVIDED';
    order.shareTrackUrl = '';
    const bossDisplayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ').trim() || 'Fer aex';
    order.bossName = bossDisplayName;
    order.placedByName = bossDisplayName;
    if (!order.swiggyOrderId && order.pendingSwiggyOrderId) order.swiggyOrderId = order.pendingSwiggyOrderId;
    saveDb(db);
    await updateOrderCards(order);

    const trackingUrl = getStoredSwiggyTrackingUrl(order);
    const displayOrderId = String(order.swiggyOrderId || order.id || '').trim();
    const bossNameEsc = escapeHtml(bossDisplayName);
    const trackEsc = escapeHtml(trackingUrl);
    const otpLine = order.deliveryOtp
      ? `\n<b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`
      : '';
    try {
      await bot.telegram.sendMessage(
        order.fwdSenderUserId || order.userId,
        `${bossNameEsc} has just placed an order (ID: ${escapeHtml(displayOrderId)}) for you on Swiggy. Click this link to track: <a href="${trackEsc}">${trackEsc}</a>` +
        `${otpLine}`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.url('Open Swiggy tracking', trackingUrl)]])
        }
      );
      // 📱 SMS band — Swiggy khud recipient ke number par SMS + tracking link bhejta hai
      // (OFO order hone par). Bot false claim nahi karega.
      await ctx.reply(`✓ <b>Swiggy tracking link sent to ${escapeHtml(order.userName || 'customer')}.</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await ctx.reply(`! Failed to send tracking: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }

  // Unified Direct Boss Card Workflow (Non-Blocking 10x Parallel Dispatch!):
  // Supports sharing 10+ different Cart + Address orders rapidly without waiting or overwriting previous orders!
  if (isBoss(userId) && (looksLikeBossOrderInput(rawText) || (state && ['waiting_cart', 'waiting_address'].includes(state.action)))) {
    delete userWaitState[userId];
    void handleBossForwardedOrderInput(ctx, {
      rawText,
      formatOrderBodyFn: formatUserOrderCardText,
      nonBlockingAutoSync: true
    }).catch(e => console.error('[BossDirectOrderIntake]', e));
    return;
  }

  // Direct Order ID paste → instant Extract Tracking offer (user enters Swiggy/Bot order ID anywhere)
  // Fires when text is just an order ID (FWD..., ORD..., or 9-20 digit Swiggy ID) and no active multi-step flow
  {
    const t = String(rawText || '').trim();
    const compact = t.replace(/\s+/g,'');
    const isPlainOrderId = looksLikePlainOrderId(compact);
    // Only trigger if not already handling cart/address/boss input and text is exactly the ID (not a cart/address URL)
    if (isPlainOrderId && !extractAllLinks(t).length && !isBoss(userId) || isPlainOrderId && isBoss(userId) && !looksLikeBossOrderInput(rawText)) {
      // Avoid double-fire when user is in waiting_boss_extract_tracking (already handled above)
      if (!state || state.action !== 'waiting_boss_extract_tracking') {
        const dbTmp = getDb();
        let found = dbTmp.orders?.[compact] || dbTmp.orders?.[compact.toUpperCase()] || dbTmp.orders?.[compact.toLowerCase()];
        if (!found) {
          const qL = compact.toLowerCase();
          for (const oo of Object.values(dbTmp.orders||{})) {
            if (String(oo.id||'').toLowerCase()===qL || String(oo.swiggyOrderId||'')===compact || String(oo.pendingSwiggyOrderId||'')===compact) { found = oo; break; }
          }
        }
        // If found or looks like Swiggy numeric ID, offer Extract button (don't auto-scan to avoid spam; button triggers scan)
        if (found || /^\d{9,20}$/.test(compact)) {
          const labelId = found ? found.id : compact;
          const displayId = found ? (found.swiggyOrderId || found.id) : compact;
          const existingTrack = found ? getStoredSwiggyTrackingUrl(found) : '';
          const foundLiveStatus = found ? (normalizeSwiggyLiveOrderStatus(found.liveOrderStatus) || String(found.liveOrderStatus || '')) : '';
          const foundDeliveredUrl = !existingTrack && found && /deliv/i.test(foundLiveStatus) && !/cancel|refus|return/i.test(foundLiveStatus)
            ? buildSignedOrderTrackUrl(displayId)
            : '';
          if (existingTrack || foundDeliveredUrl) {
            const activeLink = existingTrack || foundDeliveredUrl;
            await ctx.reply(`🔗 <b>Order #${escapeHtml(String(displayId))} — Tracking available</b>\n<a href="${escapeHtml(activeLink)}">${escapeHtml(activeLink)}</a>` + (found?.deliveryOtp ? `\n🔢 OTP: <code>${escapeHtml(String(found.deliveryOtp))}</code>` : ''), { parse_mode:'HTML', link_preview_options:{is_disabled:true}, ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Order Tracking', activeLink)] , [Markup.button.callback('🔄 Refresh Tracking', `extract_now_${labelId}`)]]) }).catch(()=>{});
          } else {
            await ctx.reply(`📦 <b>Order #${escapeHtml(String(displayId))} detected</b>\nTap below to extract its live Swiggy tracking link (scans all logged-in Swiggy IDs):`, { parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔗 Extract Tracking Link', `extract_now_${labelId}`)], [{ text: '📋 Copy Order ID', copy_text: { text: String(labelId) } }]]) }).catch(()=>{});
          }
          // Don't return — let normal flow continue if this was actually a cart? But plain ID is not cart, so stop here
          if (isPlainOrderId) return;
        }
      }
    }
  }

  // Direct, flexible user input: accept Cart OR Address (or both together!) in ANY order,
  // even if the user previously tapped the other button! Only show a short 1-line hint if
  // the message contains neither a valid cart nor a valid delivery address.
  const allLinks = extractAllLinks(rawText);
  const validCartLink = allLinks.find(l => isValidSwiggyCartUrl(l));
  const validAddrLink = allLinks.find(l => isValidDeliveryAddressUrl(l));
  const parsedCartDirect = parseCartDetails(rawText);
  const parsedAddrDirect = parseAddressDetails(rawText);

  // 🛠 Boss (29-10-2026): "ab address ko kya hua wo kyu nahi le raha".
  // Customer ne seedha address TYPE kiya, par strict parser ko city/pincode/
  // keyword na milne se null mila — bot address chup-chaap gira kar wapas
  // "Cart + Address link chahiye" bolta tha. Jab bot khud address maang raha ho
  // (ya cart aa chuka hai aur address baaki hai) to address-jaisa text accept karo.
  const preDraft = getDraft(userId);
  const askingAddressNow = Boolean(
    (state && ['waiting_address', 'waiting_both_links'].includes(state.action)) ||
    (preDraft.cart && !preDraft.address) ||
    (!preDraft.cart && !preDraft.address && simpleChatForUser(userId) && Boolean(String(rawText || '').trim()))
  );
  const looseAddrDirect = (!parsedAddrDirect && !validAddrLink && askingAddressNow)
    ? parseLooseAddress(rawText)
    : null;
  const addrDirect = parsedAddrDirect || looseAddrDirect;
  const hasAnyValidOrderInput = Boolean(validCartLink || validAddrLink || parsedCartDirect || addrDirect);

  // SIMPLE MODE: one short line, never a lecture. The card already shows what is
  // missing; the customer only has to paste the links (no typing at all).
  if (!hasAnyValidOrderInput && state?.action === 'waiting_both_links' && simpleChatForUser(userId)) {
    await renderUserCard(ctx, userId, { deleteIncoming: true, notice: 'Cart + Address link chahiye' });
    return;
  }

  if (!hasAnyValidOrderInput && state && (state.action === 'waiting_cart' || state.action === 'waiting_address')) {
    const askingCart = state.action === 'waiting_cart';
    await ctx.reply(
      askingCart
        ? '🟠 Sahi <b>Cart link</b> bhejein 👇'
        : '🟠 Sahi <b>Address link</b> ya Location bhejein 👇',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            askingCart
              ? { text: '🟠 🛒 Cart Link', callback_data: 'action_paste_cart', style: 'danger' }
              : { text: '🟠 📍 Address Link', callback_data: 'action_paste_address', style: 'danger' }
          ]
        ])
      }
    );
    return;
  }

  // Unified Ingestion (Links OR Structured Receipt/Address text pasted directly, in any order)
  if (allLinks.length > 0 || hasAnyValidOrderInput) {
    let addedCart = false;
    let addedAddress = false;
    let hadFake = false;
    let addressResolvedThisPaste = false;

    // A freshly pasted address link gets a fresh chance: forget any remembered
    // verdict for that token, otherwise an old "expired" would fire instantly
    // and the customer would swear the bot rejects every new link.
    if (validAddrLink) clearOfoResolutionFailures(validAddrLink);
    if (addrDirect) clearOfoResolutionFailures(rawText);

    // Fetch both Cart and Address links simultaneously in parallel via Promise.all!
    const [cartMeta, addrMeta] = await Promise.all([
      validCartLink ? resolveSwiggyLink(validCartLink).catch(() => null) : Promise.resolve(null),
      validAddrLink ? resolveSwiggyLink(validAddrLink).catch(() => null) : (parsedAddrDirect ? resolveSwiggyLink(rawText).catch(() => null) : Promise.resolve(null))
    ]);

    if (validCartLink || parsedCartDirect) {
      const mergedCartDetails = {
        ...(parsedCartDirect || {}),
        ...(cartMeta?.cartDetails || {})
      };
      if (cartMeta?.restaurantName && !mergedCartDetails.restaurantName) {
        mergedCartDetails.restaurantName = cartMeta.restaurantName;
      }
      updateDraft(userId, {
        cart: validCartLink || 'https://www.swiggy.com/cart',
        ...(cartMeta?.restaurantId ? { restaurantId: cartMeta.restaurantId } : {}),
        ...(cartMeta?.groupCartId ? { groupCartId: cartMeta.groupCartId } : {}),
        ...(cartMeta?.hostName ? { hostName: cartMeta.hostName } : {}),
        cartDetails: mergedCartDetails
      });
      addedCart = true;
    }

    if (addrDirect || validAddrLink) {
      let geoAddr = addrDirect;
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        geoAddr = { ...(geoAddr || {}), ...addrMeta.addressDetails };
      } else if (geoAddr) {
        try { geoAddr = await geocodeAddressDetails(geoAddr); } catch (e) {}
      }

      // If mobile number was included in message text, preserve it
      const phoneMatch = rawText.match(/(?:(?:phone|mobile|contact|tel|call)[\s:.-]*)?(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?([6-9]\d{4}[\s-]?\d{5})\b/i);
      if (geoAddr && !geoAddr.mobile && phoneMatch) {
        geoAddr.mobile = phoneMatch[1].replace(/\D/g, '');
      }

      // A typed/GPS address replaces any previously stored share link — otherwise
      // the stale (broken) link keeps being used and fails forever.
      const typedOverridesLink = Boolean(addrDirect) && !validAddrLink;
      // A new link/typed address is a NEW attempt: drop the previous failure
      // marker so an old dead link's verdict can never be shown for this one.
      const freshAddressDetails = { ...(geoAddr || {}) };
      delete freshAddressDetails.unresolvableShortLink;
      delete freshAddressDetails.unresolvedReason;

      // Did we really GET an address, or did we only store the link? The card
      // must not show a green "✓ Address" for a link Swiggy never opened — that
      // is what made the customer say "address fetched, but it still asks retry".
      const resolvedFromLink = Boolean(
        addrMeta?.addressDetails &&
        !addrMeta.addressDetails.unresolvableShortLink &&
        (addrMeta.addressDetails.address || (addrMeta.addressDetails.lat && addrMeta.addressDetails.lng))
      );
      const resolvedTextAddress = Boolean(
        geoAddr && (geoAddr.address?.length >= 6 || (geoAddr.lat && geoAddr.lng)) &&
        !geoAddr.unresolvableShortLink
      );
      const addressIsResolved = resolvedFromLink || resolvedTextAddress;
      addressResolvedThisPaste = addressIsResolved;
      if (validAddrLink && !addressIsResolved) {
        // Keep the link (Retry can retry it) but say honestly that it is not
        // open yet, so the card never claims a fetched address it does not have.
        freshAddressDetails.unresolvableShortLink = true;
        freshAddressDetails.unresolvedReason =
          getOfoResolutionFailureReason(validAddrLink) || 'UNEXPANDED';
        freshAddressDetails.link = validAddrLink;
      }
      // NEVER overwrite clean street address with bare JgkQ URL!
      updateDraft(userId, {
        address: geoAddr?.address || validAddrLink || `${geoAddr?.city || 'Delivery'} Address`,
        // Link-shared messages: store the resolved address, never the pasted chat text.
        addressOriginalText: geoAddr?.address || validAddrLink || stripSharedLinks(rawText),
        ...(validAddrLink
          ? { addressLink: validAddrLink, addressTyped: false }
          : (typedOverridesLink ? { addressLink: null, addressTyped: true } : {})),
        addressDetails: freshAddressDetails
      });
      addedAddress = true;
    }

    for (const l of allLinks) {
      if (!isValidSwiggyCartUrl(l) && !isValidDeliveryAddressUrl(l) && !parsedCartDirect && !parsedAddrDirect) {
        hadFake = true;
      }
    }

    delete userWaitState[userId];
    const curDraft = getDraft(userId);

    if (hadFake && !addedCart && !addedAddress) {
      await ctx.reply(
        '🟠 Sahi <b>Cart</b> ya <b>Address link</b> bhejein 👇',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              { text: '🟠 🛒 Cart Link', callback_data: 'action_paste_cart', style: 'danger' },
              { text: '🟠 📍 Address Link', callback_data: 'action_paste_address', style: 'danger' }
            ]
          ])
        }
      );
      return;
    }

    let nextPrompt = '';
    if (curDraft.cart && curDraft.address) {
      delete userWaitState[userId];
    } else if (addedCart && !curDraft.address) {
      userWaitState[userId] = { action: 'waiting_address' };
      nextPrompt = 'address';
    } else if (addedAddress && !curDraft.cart) {
      userWaitState[userId] = { action: 'waiting_cart' };
      nextPrompt = 'cart';
    }
    const savedNotice = addedCart && addedAddress
      ? '✓ Cart & Address saved'
      : (addedCart ? '✓ Cart link saved' : '✓ Address link saved');
    const honestNotice = addedAddress && !addressResolvedThisPaste
      ? '⚠️ Address link mila — Swiggy se khul nahi paya'
      : savedNotice;

    // SIMPLE MODE: both links present -> go straight to the bill. The customer
    // confirms once on the bill card; nothing else is typed or opened.
    // EXCEPTION: if the address link never opened, do NOT start the order just
    // to fail and ask for a retry — say it right here with the fix buttons.
    const addressUsable = Boolean(
      curDraft.addressDetails &&
      !curDraft.addressDetails.unresolvableShortLink &&
      (String(curDraft.addressDetails.address || '').trim().length >= 8 ||
        (curDraft.addressDetails.lat && curDraft.addressDetails.lng) ||
        // Customer ne khud address type kiya hai — usko "kahin na kahin" mat gira.
        (curDraft.addressTyped && String(curDraft.addressDetails.address || curDraft.address || '').trim().length >= 6))
    );
    if (simpleChatForUser(userId) && curDraft.cart && curDraft.address && !addressUsable) {
      await cleanupUserChat(ctx.telegram, ctx.chat?.id || userId, userId, {
        deleteIncomingId: ctx.message?.message_id || null
      }).catch(() => {});
      const pasteFailure = getOfoResolutionFailureReason(curDraft.addressLink || curDraft.address || '');
      if (pasteFailure === 'EXPIRED') {
        // Swiggy really rejected this token — say so now (once), drop the dead
        // link so Continue can never re-run it, and offer the two ways forward.
        clearOfoResolutionFailures(curDraft.addressLink || '');
        const keepTypedPaste = Boolean(curDraft.addressTyped && curDraft.address && !isLinkString(String(curDraft.address)));
        updateDraft(userId, {
          address: keepTypedPaste ? curDraft.address : null,
          addressOriginalText: keepTypedPaste ? (curDraft.addressOriginalText || '') : '',
          addressLink: null,
          addressDetails: keepTypedPaste ? (curDraft.addressDetails || {}) : {},
          addressTyped: keepTypedPaste
        });
        userWaitState[userId] = { action: 'waiting_address' };
        return ctx.reply(
          `🟠 <b>Address link expire ho gaya</b> — naya link bhejein, ya seedha address type kar dein 👇`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[
              { text: '🟠 📍 Naya Address Link', callback_data: 'action_paste_address', style: 'danger' },
              { text: '✍️ Address type karein', callback_data: 'simple_type_address', style: 'primary' }
            ]])
          }
        );
      }
      return ctx.reply(
        `⏳ <b>Address abhi khul nahi paya</b>\n\n` +
        `<i>Link save hai — dobara paste karne ki zaroorat nahi. Neeche se retry karein, ya seedha address type kar dein.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [{ text: '↻ Retry address', callback_data: 'simple_retry_address', style: 'primary' }],
            [{ text: '✍️ Address type karein', callback_data: 'simple_type_address', style: 'primary' }]
          ])
        }
      );
    }
    if (simpleChatForUser(userId) && curDraft.cart && curDraft.address && !getActiveUserOrder(userId)) {
      // ✅ Boss (30-10-2026): links paste hone ke baad SIRF ek message —
      // "ID apne phone me login karne ke liye ye button dabaye". Order tab
      // shuru hota hai jab wo button dabta hai (bill + QR uske baad).
      await renderUserCard(ctx, userId, { deleteIncoming: true });
      return;
    }

    // One card only: the pasted link message is deleted, card shows items +
    // address and Send to Beta becomes the single next action.
    await renderUserCard(ctx, userId, { deleteIncoming: true, notice: honestNotice });
    if (nextPrompt && !simpleChatForUser(userId)) await promptForLink(ctx, userId, nextPrompt);
    return;
  }

  // Plain text fallback for normal users — single clean card, zero extra lecture bubbles
  if (!isBoss(userId)) {
    await renderUserCard(ctx, userId, { notice: '🟠 Link bhejein' });
    return;
  }

  // Fallback for Boss
  if (isBoss(userId)) {
    await ctx.reply(bossPanelCard(), { parse_mode: 'HTML', ...getBossReplyKeyboard() });
  }
});

// Telegram Location Pin & Live Location Handler (Instant Swiggy Reverse Geocoding!)
async function handleIncomingTelegramLocation(ctx, loc) {
  if (!loc || loc.latitude === undefined || loc.longitude === undefined) return;
  const userId = ctx.from.id;
  const lat = String(loc.latitude);
  const lng = String(loc.longitude);
  if (!isValidIndianDeliveryCoordinates(lat, lng)) {
    await ctx.reply('🟠 Sirf India ki delivery location bhejein.', { parse_mode: 'HTML' });
    return;
  }

  const rev = await reverseGeocodeCoords(lat, lng).catch(() => null);
  const resolvedAddr = {
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Customer',
    mobile: '',
    city: rev?.city || 'Delivery',
    area: rev?.area || '',
    landmark: rev?.landmark || '',
    address: rev?.address || `Pinned Location (${lat}, ${lng})`,
    lat,
    lng
  };

  userWaitState[userId] = { action: 'waiting_recipient_mobile' };
  updateDraft(userId, {
    address: resolvedAddr.address,
    addressOriginalText: `${resolvedAddr.address}\nLatitude: ${lat}\nLongitude: ${lng}`,
    addressLink: `https://maps.google.com/?q=${lat},${lng}`,
    addressDetails: resolvedAddr
  });

  await renderUserCard(ctx, userId, { deleteIncoming: true, notice: '✓ Location saved' });
  const mobilePrompt = await ctx.reply(
    '📞 <b>Delivery mobile number</b> bhejein (10 digit):',
    {
      parse_mode: 'HTML',
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: '10-digit mobile number...'
      }
    }
  ).catch(() => null);
  if (mobilePrompt) rememberUserPrompt(userId, mobilePrompt);
}

bot.on('contact', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const rawContact = ctx.message?.contact?.phone_number || '';
  const cleanPhone = normalizeIndianMobileNumber(rawContact);
  if (!cleanPhone) {
    return ctx.reply('⚠️ Please share a valid 10-digit Indian mobile number.');
  }
  recordUserPhone(userId, cleanPhone);
  const draft = getDraft(userId);
  draft.addressDetails = { ...(draft.addressDetails || {}), mobile: cleanPhone };
  updateDraft(userId, { addressDetails: draft.addressDetails });

  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder && (!activeOrder.status || activeOrder.status === 'PENDING' || activeOrder.cardStage === 'REVIEW')) {
    activeOrder.addressDetails = { ...(activeOrder.addressDetails || {}), mobile: cleanPhone };
    activeOrder.recipientMobile = cleanPhone;
    const db = getDb();
    if (db.orders?.[activeOrder.id]) {
      db.orders[activeOrder.id].addressDetails = activeOrder.addressDetails;
      db.orders[activeOrder.id].recipientMobile = cleanPhone;
      saveDb(db);
    }
  }

  delete userWaitState[userId];
  await ctx.reply(
    `✅ <b>Delivery Mobile Number Saved:</b> <code>${cleanPhone}</code>\n\n` +
    `Swiggy delivery partner isi number par call karega. Order for Others enabled hai.`,
    { parse_mode: 'HTML' }
  );
  if (simpleChatForUser(userId)) {
    const screen = getUserScreen(userId, ctx.from);
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard }).catch(() => {});
  }
});

bot.on('location', async (ctx) => {
  if (ctx.from?.id && isBoss(ctx.from.id)) {
    const userId = ctx.from.id;
    const state = userWaitState[userId];
    if (state?.action === 'waiting_boss_order_address') {
      const update = await applyBossOrderUpdate({
        telegram: ctx.telegram,
        bossChatId: ctx.chat.id,
        orderId: state.orderId,
        location: ctx.message?.location,
        formatOrderBodyFn: formatUserOrderCardText
      });
      if (update.ok) {
        delete userWaitState[userId];
        await ctx.reply(`✓ ${escapeHtml(update.message || 'Delivery pin saved.')}`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`! ${escapeHtml(update.error || 'Could not save this delivery pin.')}`, { parse_mode: 'HTML' });
      }
      return;
    }
    if (state?.action === 'waiting_boss_order_cart' || state?.action === 'waiting_boss_order_mobile') {
      await ctx.reply('! This prompt needs text. Use its Cart or recipient-mobile prompt, or choose the Address button to send a location pin.');
      return;
    }
    delete userWaitState[userId];
    void handleBossForwardedOrderInput(ctx, {
      location: ctx.message?.location,
      formatOrderBodyFn: formatUserOrderCardText,
      nonBlockingAutoSync: true
    }).catch(e => console.error('[BossLocOrderIntake]', e));
    return;
  }
  await handleIncomingTelegramLocation(ctx, ctx.message?.location);
});

bot.on('edited_message', async (ctx) => {
  if (ctx.editedMessage?.location) {
    const userId = ctx.editedMessage.from?.id;
    if (!userId) return;
    const lat = String(ctx.editedMessage.location.latitude);
    const lng = String(ctx.editedMessage.location.longitude);
    const rev = await reverseGeocodeCoords(lat, lng).catch(() => null);
    if (rev) {
      updateDraft(userId, {
        address: rev.address,
        addressOriginalText: `${rev.address}\nLatitude: ${lat}\nLongitude: ${lng}`,
        addressLink: `https://maps.google.com/?q=${lat},${lng}`,
        addressDetails: {
          name: [ctx.editedMessage.from.first_name, ctx.editedMessage.from.last_name].filter(Boolean).join(' ') || 'Customer',
          mobile: '',
          city: rev.city || 'Delivery',
          area: rev.area || '',
          landmark: rev.landmark || '',
          address: rev.address,
          lat,
          lng
        }
      });
    }
  }
});

// Setup Boss UPI Command (/setupi <vpa>)
bot.command(['setupi', 'set_upi'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length > 1 && parts[1].includes('@')) {
    const upi = parts[1].trim();
    const db = getDb();
    db.config.bossUpiId = upi;
    saveDb(db);
    return ctx.reply(`✓ <b>Payment UPI ID saved:</b> <code>${upi}</code>\nAb se sabhi payment QR is UPI ID par generate honge!`, { parse_mode: 'HTML' });
  }
  userWaitState[ctx.from.id] = { action: 'waiting_set_upi' };
  const currentUpi = String(getDb().config?.bossUpiId || '').trim() || '(set nahi hai)';
  await ctx.reply(
    `₹ <b>Set Boss Payment UPI ID:</b>\n\n` +
    `Current UPI ID: <code>${escapeHtml(currentUpi)}</code>\n\n` +
    `Apna UPI ID reply karein (e.g. <code>name@okaxis</code> ya <code>name@ybl</code> — placeholder ID nahi chalegi):`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Enter UPI ID...' }
    }
  );
});

// ================= USER FLOWCHART & BOTTOM BUTTON HANDLERS =================

// Cart Link Flow (asks confirmation before replacing an already-saved Cart Link, otherwise asks to paste the link)
async function handleCartLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (draft.cart) {
    return ctx.reply(
      `🟠 <b>Cart link badalna hai?</b>\n<i>Are you sure you want to change your saved Cart Link?</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            { text: '🟠 Haan, Naya Link', callback_data: 'action_confirm_change_cart', style: 'danger' },
            { text: '🟢 Yahi Rakhein', callback_data: 'action_cancel_change_link', style: 'success' }
          ]
        ])
      }
    );
  }
  userWaitState[userId] = { action: 'waiting_cart' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'cart');
}

// Address Link Flow (asks short confirmation before replacing an already-saved Address Link)
async function handleAddressLinkFlow(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (draft.address) {
    return ctx.reply(
      `🟠 <b>Address link badalna hai?</b>\n<i>Are you sure you want to change your saved Address Link?</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            { text: '🟠 Haan, Naya Address', callback_data: 'action_confirm_change_address', style: 'danger' },
            { text: '🟢 Yahi Rakhein', callback_data: 'action_cancel_change_link', style: 'success' }
          ]
        ])
      }
    );
  }
  userWaitState[userId] = { action: 'waiting_address' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'address');
}

// Cancel Order with short colorful Confirmation
// Local cancellation does not cancel an order at Swiggy. Once placement may
// have been sent, keep the original account/order intact and direct the user
// to Swiggy instead of claiming that a provider order was cancelled.
function hasPossibleSwiggyPlacement(order) {
  if (!order?.id) return false;
  return Boolean(isQrGenerationInFlight(order.id) || readSwiggyPlacement(`chat:${String(order.id).trim()}`) ||
    order.pendingSwiggyOrderId || order.pendingSwiggyUpiUri || order.realUpiIntentUri || order.swiggyPlacedUnpaid);
}

async function handleCancelOrderConfirm(ctx, orderId = null) {
  const userId = ctx.from.id;
  const db = getDb();
  const activeOrder = orderId ? db.orders[orderId] : getActiveUserOrder(userId);
  const draft = getDraft(userId);

  if (!activeOrder && !draft.cart && !draft.address) {
    return ctx.reply('i <b>Abhi koi active order ya draft nahi hai.</b>', { parse_mode: 'HTML' });
  }
  if (hasPossibleSwiggyPlacement(activeOrder)) {
    return ctx.reply('Swiggy order ho sakta hai. Bot ise cancel nahi kar sakta; original Swiggy account me My Orders check/cancel karein.');
  }

  const targetId = activeOrder ? activeOrder.id : 'draft';
  const text = activeOrder
    ? `⚠️ <b>Order #${activeOrder.id} cancel karein?</b>\n<b>${escapeHtml(activeOrder.restaurantName || 'Swiggy Order')}</b>${activeOrder.finalPayable ? ` · ₹${activeOrder.finalPayable}` : ''}`
    : `⚠️ <b>Draft clear karein?</b>`;

  const buttons = [
    [
      { text: '✖ Haan, Cancel', callback_data: `user_confirm_cancel_${targetId}`, style: 'danger' },
      { text: '🟢 Nahi, Rakhein', callback_data: `user_keep_order_${targetId}`, style: 'success' }
    ]
  ];

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// Previous Order Flow (FigJam: "show order card in short")
async function handlePreviousOrder(ctx) {
  const userId = ctx.from.id;
  const db = getDb();
  const userOrders = Object.values(db.orders || {})
    .filter(o => Number(o.userId) === Number(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (userOrders.length === 0) {
    return ctx.reply('<b>Koi previous order nahi mila!</b>\nAap pehli baar order place karne ke liye cart aur address link attach karein.', {
      parse_mode: 'HTML'
    });
  }

  const prev = userOrders[0];
  const previousTrackingLink = getStoredSwiggyTrackingUrl(prev);
  let statusBadge = prev.status;
  if (prev.status === 'COMPLETED') statusBadge = 'DELIVERED';
  else if (prev.status === 'CANCELLED') statusBadge = 'CANCELLED';
  else if (prev.status === 'REJECTED') statusBadge = 'REJECTED';
  else if (prev.status === 'ACCEPTED') statusBadge = 'IN PROGRESS';

  const dateStr = new Date(prev.createdAt).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  const shortText = `<b>PREVIOUS ORDER SUMMARY (#${prev.id})</b>\n\n` +
    `▣ <b>Restaurant:</b> ${escapeHtml(prev.restaurantName || 'Swiggy Order')}\n` +
    `◷ <b>Date:</b> ${dateStr}\n` +
    `▪ <b>Items:</b> ${prev.items && prev.items.length > 0 ? prev.items.map(i => `${escapeHtml(i.name)} (x${i.qty || i.quantity || 1})`).join(', ') : (prev.cart ? 'Swiggy Cart Items' : 'Voice/Photo Order')}\n` +
    `₹ <b>Total amount:</b> ₹${prev.finalPayable || prev.subtotal || 0}\n` +
    `● <b>Status:</b> <b>${statusBadge}</b>\n` +
    (previousTrackingLink ? `\n↗ <b>Swiggy tracking:</b> <a href="${escapeHtml(previousTrackingLink)}">Open tracking link</a>\n` : '') +
    (prev.deliveryOtp ? `<b>Delivery OTP:</b> <code>${escapeHtml(String(prev.deliveryOtp))}</code>\n` : '');

  const buttons = [];
  if (previousTrackingLink) {
    buttons.push([Markup.button.url('Open Swiggy tracking', previousTrackingLink)]);
  }
  if (prev.cart && prev.cart.startsWith('http')) {
    buttons.push([Markup.button.url('View Swiggy Cart', prev.cart)]);
  }
  buttons.push([Markup.button.callback('Back to Main Screen', 'user_back_to_main')]);

  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(shortText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {}
  }
  return await ctx.reply(shortText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

// Send to Admin Flow (User Diagram: when both links present, user can Send to Admin; Admin decides whether to accept and generate QR)
// Send to Beta with something missing: wipe the previous card/messages so the
// chat never piles up, then ask ONLY for what is still required.
async function resetCardAndAskForMissing(ctx, userId, missing) {
  const chatId = ctx.chat?.id || userId;
  const state = await cleanupUserChat(ctx.telegram, chatId, userId, { deleteCard: true });
  state.messageId = null;
  if (missing === 'cart') {
    userWaitState[userId] = { action: 'waiting_cart' };
    await ctx.reply(
      '🟠 <b>Cart link missing</b> — bhejein 👇',
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await promptForLink(ctx, userId, 'cart');
    return;
  }
  userWaitState[userId] = { action: 'waiting_address' };
  await ctx.reply(
    '🟠 <b>Delivery address missing</b> — bhejein 👇',
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await promptForLink(ctx, userId, 'address');
}

async function handleSendToBoss(ctx) {
  const userId = ctx.from.id;

  // 1. Check if user already has an active order
  const activeOrder = getActiveUserOrder(userId);
  if (activeOrder) {
    return ctx.reply(
      `⚠️ <b>Order #${activeOrder.id} pehle se chal raha hai!</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [{ text: '↻ Refresh Status', callback_data: `user_refresh_status_${activeOrder.id}`, style: 'primary' }],
          [{ text: `✖ Cancel Order #${activeOrder.id}`, callback_data: `user_confirm_cancel_${activeOrder.id}`, style: 'danger' }]
        ])
      }
    );
  }

  // 2. Both cart and address must be present — otherwise the old card is deleted
  // and the customer is asked only for the missing link.
  let draft = getDraft(userId);
  if (!draft.cart) return resetCardAndAskForMissing(ctx, userId, 'cart');
  if (!draft.address) return resetCardAndAskForMissing(ctx, userId, 'address');

  let deliveryDetails = { ...(draft.addressDetails || {}) };
  // A customer-typed address must win over an older share link. Keeping the stale
  // link is what made every retry re-run the same broken URL and report "expired"
  // again, even after a perfectly good address had been typed.
  const typedAddress = draft.addressTyped ? String(draft.address || '').trim() : '';
  const addressSource = typedAddress || draft.addressOriginalText || draft.address;
  let addressLink = typedAddress
    ? ''
    : (draft.addressLink || extractAddressShareUrl(addressSource) || (isAddressShareUrl(addressSource) ? addressSource : ''));

  // We already hold a real delivery address for this draft (resolved when the
  // link was pasted, or typed by the customer). Re-resolving the share link now
  // only adds a second chance to fail — and that second failure is exactly the
  // "address to aa gaya tha, phir bhi retry" bug. The stored address IS the truth.
  const draftAddressText = String(draft.addressDetails?.address || '').trim();
  const draftHasUsableAddress = Boolean(
    (draftAddressText && !isLinkString(draftAddressText) && draftAddressText.length >= 8) ||
    (draft.addressDetails?.lat && draft.addressDetails?.lng) ||
    (draft.addressTyped && draftAddressText && !isLinkString(draftAddressText) && draftAddressText.length >= 6)
  ) && !draft.addressDetails?.unresolvableShortLink;
  if (addressLink && draftHasUsableAddress) {
    console.warn('[AddressResolve] using the already-fetched address (no link re-resolve)');
    deliveryDetails = { ...(draft.addressDetails || {}) };
    delete deliveryDetails.unresolvableShortLink;
    delete deliveryDetails.unresolvedReason;
  }
  const skipLinkResolution = Boolean(addressLink && draftHasUsableAddress);

  if (addressLink && !skipLinkResolution) {
    // URL-FIRST: try link first, but fall back to verified address text if link fails or is unexpanded
    try {
      const addrMeta = await resolveSwiggyLink(addressSource || addressLink);
      const resolvedAd = addrMeta?.addressDetails;
      if (resolvedAd && !resolvedAd.unresolvableShortLink && (resolvedAd.address || (resolvedAd.lat && resolvedAd.lng))) {
        deliveryDetails = { ...resolvedAd };
      } else {
        const candidateAd = parseAddressDetails(addressSource, { allowWithUrl: true });
        if (candidateAd && (candidateAd.address || (candidateAd.lat && candidateAd.lng))) {
          const geocoded = await geocodeAddressDetails(candidateAd);
          deliveryDetails = { ...geocoded, ...(candidateAd.mobile ? { mobile: candidateAd.mobile } : {}) };
        } else {
          deliveryDetails = { ...deliveryDetails, ...(resolvedAd || {}), unresolvableShortLink: true };
        }
      }
    } catch (e) {}
  } else if (!addressLink) {
    // Plain-text address / GPS pin — the message itself is the source.
    // Boss (29-10-2026): typed address ko loose parser se bhi maano — warna
    // "B-402 Eldeco Greens" jaisa address yahan null ho kar order ruk jata tha.
    const parsedAddress = parseAddressDetails(addressSource, { allowWithUrl: true })
      || parseAddressDetails(addressSource)
      || parseLooseAddress(addressSource);
    if (parsedAddress) {
      for (const [key, value] of Object.entries(parsedAddress)) {
        if (value !== null && value !== undefined && value !== '') deliveryDetails[key] = value;
      }
    }
  }

  // A verified street address / GPS pin in hand means we can deliver — a dead or
  // un-openable share link must never block an order we can already fulfil.
  const usableFallbackAddress = Boolean(
    (String(deliveryDetails.address || '').trim() && !/^https?:\/\//i.test(String(deliveryDetails.address || '').trim())) ||
    (deliveryDetails.lat && deliveryDetails.lng)
  );
  if (!skipLinkResolution && addressLink && deliveryDetails.unresolvableShortLink && usableFallbackAddress) {
    console.warn(`[AddressResolve] order=${userId} link unusable but address present — continuing`);
    delete deliveryDetails.unresolvableShortLink;
    delete deliveryDetails.unresolvedReason;
    updateDraft(userId, { addressDetails: deliveryDetails });
    draft = getDraft(userId);
  }

  if (!skipLinkResolution && addressLink && deliveryDetails.unresolvableShortLink) {
    // Only claim "expired" when Swiggy itself rejected the token. An un-expanded
    // AppsFlyer short link, a timeout, a WAF block or a missing session are OUR
    // side, and the customer must always keep a way forward (retry / type address).
    const reason = deliveryDetails.unresolvedReason ||
      getOfoResolutionFailureReason(addressLink) ||
      getOfoResolutionFailureReason(addressSource);
    console.warn(`[AddressResolve] order=${userId} reason=${reason || 'UNKNOWN'} link=${String(addressLink).slice(0, 120)}`);

    if (reason === 'EXPIRED') {
      // The token really is dead. Drop it from the draft (and forget its verdict)
      // so Continue/Retry can never silently re-run the same dead link and show
      // "expired" a second time for a link the customer already replaced.
      clearOfoResolutionFailures(addressLink);
      const keepTyped = Boolean(draft.addressTyped && draft.address && !isLinkString(String(draft.address)));
      const scrubbedOriginal = typeof stripSharedLinks === 'function'
        ? String(stripSharedLinks(draft.addressOriginalText || '') || '').trim()
        : '';
      updateDraft(userId, {
        address: keepTyped ? draft.address : null,
        addressOriginalText: keepTyped ? (draft.addressOriginalText || '') : scrubbedOriginal,
        addressLink: null,
        addressDetails: keepTyped ? (draft.addressDetails || {}) : {},
        addressTyped: keepTyped
      });
      userWaitState[userId] = { action: 'waiting_address' };
      return ctx.reply(
        `🟠 <b>Address link expire ho gaya</b> — naya link bhejein, ya seedha address type kar dein 👇`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[
            { text: '🟠 📍 Naya Address Link', callback_data: 'action_paste_address', style: 'danger' },
            { text: '✍️ Address type karein', callback_data: 'simple_type_address', style: 'primary' }
          ]])
        }
      );
    }

    const headline = reason === 'UNEXPANDED'
      ? '<b>Swiggy ka link khul nahi paya</b>'
      : (reason === 'NO_ACCOUNT'
        ? '<b>Koi Swiggy account login nahi hai</b>'
        : '<b>Swiggy se address nahi mil paya abhi</b>');
    return ctx.reply(
      `⏳ ${headline}\n\n` +
      `<i>Link saved hai — dobara paste karne ki zaroorat nahi. Neeche se retry karein, ya seedha apna address type kar dein.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [{ text: '↻ Retry', callback_data: 'simple_retry_address', style: 'primary' }],
          [{ text: '✍️ Address type karein', callback_data: 'simple_type_address', style: 'primary' }]
        ])
      }
    );
  }

  const explicitRecipientMobile = normalizeDeliveryContact(
    deliveryDetails.mobile ||
    extractStandaloneMobileNumber(addressSource) ||
    addressSource.match(/(?:(?:phone|mobile|contact|tel|call)[\s:.-]*)?(?:(?:\+?91[\s-]?)|(?:0[\s-]?))?([6-9]\d{9})\b/i)?.[1]
  );
  if (!explicitRecipientMobile) {
    // SIMPLE MODE = ZERO TYPING. The Swiggy address share already carries the
    // receiver's number; if Swiggy omitted it we continue without a prompt and
    // fall back to the saved contact of the user. Never substitute account owner's phone.
    if (simpleChatForUser(userId)) {
      const userLastPhone = getUserLastDeliveryPhone(userId);
      const savedMobile = userLastPhone || normalizeDeliveryContact(
        deliveryDetails.mobile ||
        deliveryDetails.phone ||
        ''
      );
      deliveryDetails.mobile = savedMobile || '';
      deliveryDetails.mobileSource = userLastPhone ? 'USER_MEMORY' : (savedMobile ? 'SAVED_PHONE' : 'MISSING');
      updateDraft(userId, { addressDetails: deliveryDetails });
      draft = getDraft(userId);
    } else {
      userWaitState[userId] = { action: 'waiting_recipient_mobile' };
      return ctx.reply(
        `📞 <b>Delivery mobile number</b> bhejein (10 digit):`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            force_reply: true,
            selective: true,
            input_field_placeholder: '10-digit mobile number...'
          }
        }
      );
    }
  }
  if (explicitRecipientMobile) deliveryDetails.mobile = explicitRecipientMobile;
  // 👤 AUTO-FILL FROM ADDRESS LINK (professor 30-10-2026): "order for others
  // wali field address link se auto fill hoga" — jab address link resolve
  // hota hai to recipient name + mobile draft me save hote hain (Agar user
  // ne pehle se "Order for Someone Else" flow se fill nahi kara).
  const autoRecipient = {
    ...(deliveryDetails.name && !draft.recipientName ? { recipientName: deliveryDetails.name } : {}),
    ...(deliveryDetails.mobile && !draft.recipientMobile ? { recipientMobile: deliveryDetails.mobile } : {})
  };
  updateDraft(userId, { addressDetails: deliveryDetails, ...autoRecipient });
  draft = getDraft(userId);

  const db = getDb();
  const orderId = generateOrderId();
  const role = getFamilyRole(userId, 'Ammi');

  const newOrder = {
    id: orderId,
    userId: userId,
    userName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || role,
    handle: ctx.from.username ? `@${ctx.from.username}` : null,
    type: 'SWIGGY_ORDER',
    address: draft.addressDetails?.address || draft.address,
    addressOriginalText: draft.addressOriginalText || draft.address || '',
    addressLink: draft.addressLink || extractAddressShareUrl(draft.addressOriginalText || draft.address) || null,
    cart: draft.cart,
    restaurantId: draft.restaurantId || null,
    groupCartId: draft.groupCartId || null,
    hostName: draft.hostName || null,
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    isCustomerSubmitted: true,
    createdAt: new Date().toISOString(),
    autoOptimizeStartedAt: new Date().toISOString(),
    userChatId: userId,
    userMessageId: ctx.callbackQuery?.message?.message_id || null,
    bossMessageIds: {}
  };

  // SIMPLE MODE: the customer's one and only "Confirm" tap is the consent.
  // It travels with the order so no second approval is ever asked for.
  if (simpleChatForUser(userId)) {
    newOrder.simpleChat = true;
    if (draft.customerConsentGiven) {
      Object.assign(newOrder, buildConsentPatch({ finalPayable: draft.customerConsentAmount }, userId, {
        via: draft.customerConsentVia || 'TELEGRAM_BUTTON'
      }));
    }
  }

  if (draft.addressDetails) newOrder.addressDetails = draft.addressDetails;
  if (draft.cartDetails) {
    const cd = draft.cartDetails;
    if (cd.restaurantName) newOrder.restaurantName = cd.restaurantName;
    // NEVER copy the "Order Account" phone from pasted cart text: the account used
    // for the order is the Swiggy account selected by the bot, not the pasted number.
    if (cd.items && cd.items.length > 0) newOrder.items = cd.items;
    if (cd.itemsTotal > 0) { newOrder.itemTotal = cd.itemsTotal; newOrder.subtotal = cd.itemsTotal; }
    if (cd.tradeDiscountTotal > 0) newOrder.tradeDiscountTotal = cd.tradeDiscountTotal;
    if (cd.couponCode) { newOrder.couponCode = cd.couponCode; newOrder.discountAmount = cd.discountAmount; }
    if (cd.freeCashApplied > 0) newOrder.freeCashApplied = cd.freeCashApplied;
    if (cd.freeDelivery) { newOrder.swiggyOneApplied = true; newOrder.freeDeliveryDiscount = cd.deliverySaved || 0; }
    if (cd.packingCharges > 0) newOrder.packingCharges = cd.packingCharges;
    if (cd.gstCharges > 0) newOrder.taxesAndCharges = cd.gstCharges;
    if (cd.totalSavings > 0) newOrder.totalSavings = cd.totalSavings;
    if (cd.finalPayable > 0) newOrder.finalPayable = cd.finalPayable;
    else applyMaxOfferToOrder(newOrder);
  }

  // Fallback: If items are missing, resolve directly from live cart link (<150ms for group carts!)
  if (!newOrder.items || newOrder.items.length === 0) {
    try {
      const linkMeta = await resolveSwiggyLink(newOrder.cart);
      if (linkMeta?.restaurantId) newOrder.restaurantId = linkMeta.restaurantId;
      if (linkMeta?.groupCartId) newOrder.groupCartId = linkMeta.groupCartId;
      if (linkMeta?.hostName) newOrder.hostName = linkMeta.hostName;
      if (linkMeta?.cartDetails?.items?.length > 0) {
        newOrder.items = linkMeta.cartDetails.items;
        if (!newOrder.restaurantName) newOrder.restaurantName = linkMeta.restaurantName;
        if (!newOrder.subtotal) {
          newOrder.subtotal = linkMeta.cartDetails.subtotal || linkMeta.cartDetails.itemsTotal;
          newOrder.itemTotal = newOrder.subtotal;
        }
        if (linkMeta.cartDetails.tradeDiscountTotal > 0) newOrder.tradeDiscountTotal = linkMeta.cartDetails.tradeDiscountTotal;
        if (linkMeta.cartDetails.packingCharges > 0) newOrder.packingCharges = linkMeta.cartDetails.packingCharges;
        if (linkMeta.cartDetails.gstCharges > 0) newOrder.taxesAndCharges = linkMeta.cartDetails.gstCharges;
        applyMaxOfferToOrder(newOrder);
      }
    } catch (e) {}
  }

  // Fallback: If addressDetails is missing, resolve directly from address text/link without clobbering
  if (!newOrder.addressDetails && (newOrder.addressOriginalText || newOrder.address)) {
    try {
      const addrMeta = await resolveSwiggyLink(newOrder.addressOriginalText || newOrder.address);
      if (addrMeta?.addressDetails && !addrMeta.addressDetails.unresolvableShortLink) {
        newOrder.addressDetails = addrMeta.addressDetails;
        if (addrMeta.addressDetails.address) newOrder.address = addrMeta.addressDetails.address;
      }
    } catch (e) {}
  }
  if (newOrder.addressDetails?.mobile) {
    newOrder.recipientMobile = newOrder.addressDetails.mobile;
    newOrder.deliveryPhone = newOrder.addressDetails.mobile;
  }
  // 👤 ORDER FOR SOMEONE ELSE (professor 30-10-2026): draft se recipient details
  // order par attach hote hain — tracking link + SMS recipient ke number par.
  if (draft.recipientName) newOrder.recipientName = draft.recipientName;
  if (draft.recipientMobile) {
    newOrder.recipientMobile = draft.recipientMobile;
    newOrder.deliveryPhone = draft.recipientMobile;
    if (newOrder.addressDetails) {
      newOrder.addressDetails = { ...newOrder.addressDetails, mobile: draft.recipientMobile, name: draft.recipientName || newOrder.addressDetails?.name || '' };
    }
  }

  // Loophole fix: block ₹0 empty orders (e.g. tracking link mis-parsed as cart)
  const hasItems = Array.isArray(newOrder.items) && newOrder.items.length > 0;
  const hasValue = Number(newOrder.subtotal || newOrder.itemTotal || newOrder.finalPayable || 0) > 0;
  if (!hasItems && !hasValue) {
    return ctx.reply(
      `❌ <b>Cart khali hai — order nahi ban sakta</b>\n\nKripya sahi Swiggy cart link bhejein (<code>https://swig.gy/gc/...</code>) — tracking link se order nahi banta.`,
      { parse_mode: 'HTML' }
    );
  }

  db.orders[orderId] = newOrder;
  saveDb(db);
  clearDraft(userId);

  // Track the same single card the customer has been using since the links.
  if (ctx.callbackQuery?.message?.message_id) {
    rememberUserCard(userId, ctx.callbackQuery.message);
  }

  // Edit User's single card in-place if initiated via inline button, else send and sync `userChatCards`!
  const userCard = customerOrderCard(newOrder);
  if (ctx.callbackQuery?.message?.message_id) {
    try {
      await ctx.editMessageText(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
    } catch (e) {
      if (!/message is not modified/i.test(String(e?.description || e?.message || ''))) {
        const msg = await ctx.reply(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
        newOrder.userMessageId = msg.message_id;
        rememberUserCard(userId, msg);
      }
    }
  } else {
    const prevCard = userChatCards.get(String(userId));
    const msg = await ctx.reply(userCard.text, { parse_mode: 'HTML', ...userCard.keyboard });
    newOrder.userMessageId = msg.message_id;
    if (prevCard?.messageId && prevCard.messageId !== msg.message_id) {
      bot.telegram.deleteMessage(userId, prevCard.messageId).catch(() => {});
    }
    rememberUserCard(userId, msg);
  }

  // Deliver single card to Boss so Admin can DECIDE
  const bossCard = formatBossOrderCard(newOrder);
  const bossList = [...new Set([...(db.config.bossIds || []), ...(isBoss(userId) ? [userId] : [])])];
  for (const bossId of bossList) {
    try {
      const bossMsg = await sendCardSafe(bossId, bossCard);
      newOrder.bossMessageIds[bossId] = bossMsg?.message_id;
      console.log(`✓ Successfully sent Order #${orderId} to Boss: ${bossId}`);
    } catch (e) {
      console.error(`× Failed to send Order #${orderId} to Boss ${bossId}:`, e.message);
    }
  }
  // Re-read before persisting: `db` is a snapshot taken BEFORE clearDraft(), so
  // writing it back would resurrect the links the customer just sent.
  try {
    const freshDb = getDb();
    const stored = freshDb.orders?.[orderId];
    if (stored) {
      stored.bossMessageIds = { ...(stored.bossMessageIds || {}), ...(newOrder.bossMessageIds || {}) };
      if (newOrder.userMessageId) stored.userMessageId = newOrder.userMessageId;
      freshDb.orders[orderId] = stored;
      saveDb(freshDb);
    } else {
      freshDb.orders[orderId] = newOrder;
      saveDb(freshDb);
    }
  } catch (e) {
    console.warn('[SendToBoss] post-card save failed:', e?.message || e);
  }

  // Background pipeline for customer submissions — same treatment as a forwarded order:
  // 1) resolve the live cart + address (without duplicate vault scan), 2) auto-pick the best account, 3) lock the max offer & send bill confirmation.
  triggerBackgroundCartFetch(orderId, { skipAccountScan: true })
    .then(() => autoOptimizeUserOrder(orderId, { reason: 'CUSTOMER_SEND_TO_BETA' }))
    .catch(err => console.error(`[BackgroundFetch] Order #${orderId} error:`, err?.stack || err?.message || err));
}

// Action Callbacks for User Screen & Flowchart
bot.action('action_add_cart', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCartLinkFlow(ctx);
});

bot.action(['action_paste_cart', 'action_force_change_cart', 'action_change_cart_link', 'action_confirm_change_cart'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_cart' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'cart');
});

bot.action('action_add_address', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleAddressLinkFlow(ctx);
});

bot.action(['action_paste_address', 'action_force_change_address', 'action_change_address_link', 'action_confirm_change_address'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_address' };
  await renderUserCard(ctx, userId);
  await promptForLink(ctx, userId, 'address');
});

bot.action('action_cancel_change_link', async (ctx) => {
  await ctx.answerCbQuery('Link preserved ●').catch(() => {});
  const userId = ctx.from.id;
  // Keep editing the existing card instead of posting another copy of the screen.
  await renderUserCard(ctx, userId);
});

// ---------------------------------------------------------------------------
// SIMPLE CHAT MODE (customers only) — two links in, one tap consent, tracking out
// ---------------------------------------------------------------------------
// Nothing here talks to a web app: the whole journey is inline Telegram buttons.

// Both links already in the draft -> create the order and let the existing
// max-offer engine compute the bill (no money moves until the customer confirms).
const simpleAutoStartInFlight = new Set();

async function startSimpleOrderFromDraft(ctx, userId) {
  const key = String(userId || '');
  if (!key || simpleAutoStartInFlight.has(key)) return false;
  const draft = getDraft(userId);
  if (!draft?.cart || !draft?.address) return false;
  if (getActiveUserOrder(userId)) return false;
  simpleAutoStartInFlight.add(key);
  const chatId = ctx.chat?.id || userId;
  const priorCardId = userCardState(userId).messageId;
  try {
    await handleSendToBoss(ctx);
    // A text paste has no callbackQuery, so the order card is posted fresh.
    // Remove the previous (link) card so the chat keeps ONE live card.
    const created = Object.values(getDb().orders || {})
      .filter((o) => o && Number(o.userId) === Number(userId))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    const newCardId = created?.userMessageId;
    if (newCardId && priorCardId && Number(newCardId) !== Number(priorCardId)) {
      try { await ctx.telegram.deleteMessage(chatId, priorCardId); } catch {}
      rememberUserCard(userId, { message_id: newCardId, chat: { id: chatId } });
    }
    return true;
  } catch (err) {
    console.error('[SimpleChat] auto start failed:', err?.stack || err?.message || err);
    return false;
  } finally {
    simpleAutoStartInFlight.delete(key);
  }
}

async function promptSimpleBothLinks(ctx) {
  const userId = ctx.from.id;
  userWaitState[userId] = { action: 'waiting_both_links' };
  const chatId = ctx.chat?.id || userId;
  const state = userCardState(userId);
  for (const id of state.promptIds) {
    try { await ctx.telegram.deleteMessage(chatId, id); } catch {}
  }
  state.promptIds = [];
  try {
    const prompt = await ctx.reply(
      '🛒 <b>Cart link</b> + 📍 <b>Address link</b> — saath ya alag bhejein 👇',
      {
        parse_mode: 'HTML',
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: 'Swiggy cart link + address link…'
        }
      }
    );
    rememberUserPrompt(userId, prompt);
    return prompt;
  } catch (err) {
    console.warn('[SimpleChat] prompt failed:', err?.message || err);
    return null;
  }
}

bot.action(SIMPLE_CHAT_CALLBACKS.pasteLinks, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await promptSimpleBothLinks(ctx);
});

// ── 👤 ORDER FOR SOMEONE ELSE (professor 30-10-2026) ─────────────────────────
// "uspar click karne par uska name and mobile number daalne ka option aata".
// Pehle naam, phir mobile — dono draft me save hote hain. Order creation par
async function startOrderForSomeoneElse(ctx) {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  // 👤 AUTO-FILL FROM ADDRESS LINK: agar address link se recipient name +
  // mobile pehle se draft me hain, to puchna skip karo aur cart bhejne ko bolo.
  if (draft.recipientName && draft.recipientMobile) {
    delete userWaitState[userId];
    await ctx.reply(
      `👤 <b>Order for Someone Else</b>\n\n` +
      `<i>Address link se auto-fill hua hai:</i>\n\n` +
      `<b>Naam:</b> ${escapeHtml(draft.recipientName)}\n` +
      `<b>Mobile:</b> ${escapeHtml(draft.recipientMobile)}\n\n` +
      '<i>Cart link bhejein:</i>',
      { parse_mode: 'HTML' }
    ).catch(() => null);
    return;
  }
  // Pehle naam, phir mobile — dono draft me save hote hain. Order creation par
  delete userWaitState[userId];
  userWaitState[userId] = { action: 'waiting_recipient_name' };
  await ctx.reply(
    '👤 <b>Order for Someone Else</b>\n\n' +
    '<i>Kaun ke liye order hai? Naam likhein (jaise: Rahul, Abbu, Sir):</i>',
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Recipient name...' }
    }
  ).catch(() => null);
}

bot.action('action_order_for_others', startOrderForSomeoneElse);
bot.action(SIMPLE_CHAT_CALLBACKS.orderForOthers, startOrderForSomeoneElse);

bot.action(SIMPLE_CHAT_CALLBACKS.continueDraft, async (ctx) => {
  await ctx.answerCbQuery('Bill check kar raha hoon…').catch(() => {});
  const started = await startSimpleOrderFromDraft(ctx, ctx.from.id);
  if (!started) await renderUserCard(ctx, ctx.from.id, { notice: 'Dono links chahiye' }).catch(() => {});
});

bot.action(SIMPLE_CHAT_CALLBACKS.clearDraft, async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  clearDraft(userId);
  await ctx.answerCbQuery('Cleared ✓').catch(() => {});
  await renderUserCard(ctx, userId);
});

bot.action(SIMPLE_CHAT_CALLBACKS.newOrder, async (ctx) => {
  const userId = ctx.from.id;
  delete userWaitState[userId];
  // Dismiss the finished/failed card so the fresh screen really is empty.
  const focus = getSimpleFocusOrder(userId);
  if (focus?.id) {
    mutateDb((d) => {
      const stored = d.orders?.[focus.id];
      if (stored) stored.simpleCardDismissed = true;
    });
  }
  clearDraft(userId);
  await ctx.answerCbQuery('Naya order ✓').catch(() => {});
  // Delete the finished order card first, then post a single fresh one.
  await cleanupUserChat(ctx.telegram, ctx.chat?.id || userId, userId, { deleteCard: true }).catch(() => {});
  userChatCards.delete(String(userId));
  const screen = getUserScreen(userId, ctx.from);
  const sent = await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  rememberUserCard(userId, sent);
});

// Escape hatch: the customer types (or pins) the address when the Swiggy share
// link cannot be opened. Low input first, but never a dead end.
bot.action('simple_type_address', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[userId] = { action: 'waiting_address' };
  // Clear the whole unusable address (link + the text that carried it), otherwise
  // Continue would re-extract the same broken link from `addressOriginalText`.
  updateDraft(userId, {
    address: null,
    addressOriginalText: '',
    addressLink: null,
    addressDetails: {},
    addressTyped: false
  });
  const prompt = await ctx.reply(
    '✍️ <b>Address type karein</b>\n\n' +
    '<i>Flat / house, area, landmark aur city likh dein. Ya 📎 → Location bhej dein.</i>',
    { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Flat 4, Gomti Nagar, Lucknow 226010' } }
  ).catch(() => null);
  if (prompt) rememberUserPrompt(userId, prompt);
});

// The address share link is still saved — retry the same links, no re-paste.
bot.action('simple_retry_address', async (ctx) => {
  await ctx.answerCbQuery('Dobara try kar raha hoon…').catch(() => {});
  // Retry means really retry: forget the remembered failure for this link,
  // otherwise the cached verdict answers instantly without asking Swiggy.
  const retryDraft = getDraft(ctx.from.id);
  clearOfoResolutionFailures(retryDraft.addressLink || retryDraft.addressOriginalText || retryDraft.address || '');
  const started = await startSimpleOrderFromDraft(ctx, ctx.from.id);
  if (!started) await renderUserCard(ctx, ctx.from.id, { notice: 'Abhi bhi nahi mila — thodi der baad try karein' }).catch(() => {});
});

// ── 👛 USER WALLET + ₹ SERVICE FEE (boss 29-10-2026) ────────────────────────
// "Har order par ₹15 charge karna hai… pata kaise chalega ki paisa sach me aaya?
//  UTR verify karo — aur mujhe ek user vault do jisme balance dekhu aur adjust karu."
//
// Flow: cart/address/bill FREE → "QR banao" par balance check → fee kati jaati hai
// → QR. Balance kam → UPI + UTR card. UTR provider se ya boss se verify → balance
// judta hai → QR khud ban jata hai. Cancel (place hone se pehle) → refund.

function walletUpiId() {
  // Legacy order-fee UPI stays separate from the Mini App wallet setting.
  const db = getDb();
  const bossUpi = String(db.config?.bossUpiId || process.env.BOSS_UPI_ID || process.env.UPI_ID || '').trim();
  return bossUpi || configuredWalletUpiId(db);
}

function walletOwnerId(order, fallback = '') {
  const forwarded = String(order?.fwdSenderUserId || '').trim();
  const candidate = String(order?.userId || order?.userChatId || fallback || '').trim();
  if (order?.isForwardedOrder && !order?.isDirectBossOrder && !forwarded && isBoss(candidate)) return '';
  return forwarded || candidate;
}

function walletNameOf(userId, fallback = '') {
  const db = getDb();
  const u = db.users?.[String(userId)] || {};
  return String(u.name || u.firstName || fallback || '').slice(0, 60);
}

/** Boss panel se set fee (db.config.serviceFeePaise) — warna env default. */
function feePaiseNow() {
  return serviceFeePaiseFor(getDb());
}

/** Customer ke liye "Admin se baat" button (har jagah). */
function supportRow() {
  return [{ text: '🆘 Admin se baat karein', callback_data: 'support_contact_admin', style: 'primary' }];
}

/**
 * Order ka QR ban gaya hai par verification baaki — customer ko yeh card.
 * Boss (30-10-2026): "user ko feel na ho ki wo order par fees de raha" —
 * isliye bhasha refundable verification ki hai, wallet/balance ki nahi.
 */
/**
 * 🔐 FEE KA ASLI QR (boss 30-10-2026, naya plan)
 *
 * "if qr generate success the user wont receive the qr but after they pay the fee
 *  amount on given qr and utr will auto verify and then show them qr"
 *
 * Matlab: order QR ban gaya to sabse pehle customer ko sirf FEE ka QR jata hai
 * (₹15, boss ki UPI). Paisa aaya + verify hua → tab order QR jata hai.
 * Agar QR generation fail → koi fee nahi, seedha "shuru se dobara try".
 */
async function sendFeeQrForHeldOrder(order, { feePaise: feeOverride = 0 } = {}) {
  if (!order) return { ok: false, reason: 'no order' };
  const fee = Number(feeOverride) || feePaiseNow();
  const chatId = order.userChatId || order.userId;
  const upi = walletUpiId();
  const upiReady = Boolean(upi) && !isPlaceholderUpiId(upi) && isValidUpiVpa(upi);
  order.cardStage = 'AWAITING_FEE';
  order.feeDuePaise = fee;
  order.feeQrSentAt = new Date().toISOString();
  const db = getDb();
  db.orders[order.id] = order;
  saveDb(db);

  let qrSent = false;
  if (upiReady && fee > 0 && chatId) {
    try {
      const amount = (fee / 100).toFixed(2).replace(/\.00$/, '');
      const tr = `FEE${String(order.id).replace(/[^A-Za-z0-9]/g, '').slice(-14)}`.slice(0, 35);
      const feeUri = sanitizeUpiUriForQr(
        `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent('VERIFICATION FEE')}` +
        `&am=${amount}&cu=INR&tn=${encodeURIComponent(`Fee ${order.id}`)}&tr=${tr}`
      );
      const qrBuffer = await QRCode.toBuffer(feeUri, { type: 'png', width: 720, margin: 3, errorCorrectionLevel: 'M' });
      await bot.telegram.sendPhoto(chatId, { source: qrBuffer }, {
        caption: safeTelegramCaption(
          `🔐 <b>₹${walletRupees(fee)} ka QR</b>\n` +
          `<i>Ye order ka payment nahi — sirf verification. Pay karte hi order ka QR yahin aa jayega.</i>`,
          900
        ),
        parse_mode: 'HTML'
      });
      qrSent = true;
      order.feeQrMessageId = null;
    } catch (err) {
      console.warn('[FeeQr] QR image failed:', err?.message || err);
    }
  }

  if (chatId) {
    await bot.telegram.sendMessage(
      chatId,
      formatOrderVerificationCard({
        orderId: order.id,
        restaurant: order.restaurantName || '',
        feePaise: fee,
        upiId: upiReady ? upi : ''
      }) + (upiReady ? '' : '\n\n<i>UPI abhi set nahi — admin se baat karein, wo turant set kar dega.</i>'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [{ text: '✅ Maine pay kar diya', callback_data: `wallet_fee_paid_${order.id}`, style: 'success' }],
          supportRow()
        ])
      }
    ).catch(() => {});
  }

  // Boss ko sach: QR ban gaya, fee ka intezaar, customer ko order QR abhi nahi gaya.
  for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
    await bot.telegram.sendMessage(
      bossId,
      `🧊 <b>ORDER QR BAN GAYA (customer ko nahi bheja)</b>\n` +
      `Order <code>#${escapeHtml(String(order.id))}</code> · ₹${escapeHtml(String(order.finalPayable || order.subtotal || 0))}\n` +
      `₹${walletRupees(fee)} verification ka QR customer ko bheja — pay + verify hote hi asli order QR jayega.\n` +
      (autoVerifyConfigured()
        ? '<i>Auto-verify ON: paisa aate hi khud release hoga.</i>'
        : '<i>⚠️ Auto-verify OFF: 3 min me khud release ho jayega aur fee \"baad me lene wali\" me chali jayegi.</i>'),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[{ text: '🧮 Wallet & Fee', callback_data: 'boss_fee_panel', style: 'primary' }]])
      }
    ).catch(() => {});
  }

  // Safety valve (thread #32 ka sach): auto-verify set na ho to customer hamesha
  // ke liye atka nahi reh sakta — 3 min baad QR release + fee deferred.
  if (!autoVerifyConfigured()) {
    scheduleDeferredQrRelease(order.id, fee);
  }
  return { ok: true, feePaise: fee, qrSent, upiReady };
}

/** Auto-verify off hone par QR ko atka mat chhodo — 3 min baad release + fee due. */
function scheduleDeferredQrRelease(orderId, feePaise) {
  try {
    const timer = setTimeout(async () => {
      try {
        const db = getDb();
        const order = db.orders?.[orderId];
        if (!order || !isOrderQrHeld(order)) return;
        if (Number(order.feeChargedPaise || 0) > 0) return;
        recordDeferredFee(order, Number(feePaise) || feePaiseNow(), { reason: 'auto-verify off — 3 min me fee defer' });
        db.orders[orderId] = order;
        saveDb(db);
        await releaseHeldQrToCustomer(orderId, { reason: 'auto-verify off — fee baad me' });
        for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
          await bot.telegram.sendMessage(
            bossId,
            `🧾 <b>FEE BAAD ME</b> · order <code>#${escapeHtml(String(orderId))}</code>\n` +
            `<i>Auto-verify set nahi hai, 3 min me verification nahi aayi — customer ka QR release kar diya. Due Wallet & Fee panel me hai.</i>`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '🧮 Wallet & Fee', callback_data: 'boss_fee_panel', style: 'primary' }]]) }
          ).catch(() => {});
        }
      } catch (err) {
        console.warn('[FeeQr] deferred release failed:', err?.message || err);
      }
    }, 3 * 60 * 1000);
    if (typeof timer?.unref === 'function') timer.unref();
  } catch { /* timer best-effort */ }
}

/** Fee verify hui → held QR release karke customer ko asli QR bhejo. */
async function releaseHeldQrToCustomer(orderId, { reason = '' } = {}) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { ok: false, code: 'NO_ORDER' };
  if (!isOrderQrHeld(order)) return { ok: false, code: 'NOT_HELD' };
  releaseOrderQr(order);
  order.cardStage = 'PAYMENT_READY';
  order.feeDuePaise = 0;
  order.qrReleaseReason = String(reason || '').slice(0, 120);
  order.qrReleasedForCustomerAt = new Date().toISOString();
  db.orders[orderId] = order;
  saveDb(db);
  try {
    await sendApprovedOrderPaymentToUser(String(order.userId), order);
  } catch (err) {
    console.warn('[FeeQr] order QR send failed:', err?.message || err);
  }
  await updateOrderCards(getDb().orders?.[orderId] || order).catch(() => {});
  return { ok: true };
}

async function sendOrderVerificationCard(order, { balancePaise = 0, neededPaise = 0 } = {}) {
  const userId = walletOwnerId(order);
  if (!userId) return false;
  const db = getDb();
  const fee = feePaiseNow();
  ensureWallet(db, userId, { name: walletNameOf(userId, order.userName || '') });
  saveDb(db);
  const upi = walletUpiId();
  const upiReady = Boolean(upi) && !isPlaceholderUpiId(upi) && isValidUpiVpa(upi);
  const card = formatOrderVerificationCard({
    orderId: order.id,
    restaurant: order.restaurantName || '',
    feePaise: fee,
    upiId: upiReady ? upi : ''
  }) + (upiReady ? '' : '\n\n<i>UPI abhi set nahi — admin se baat karein, wo turant set kar dega.</i>');
  const kb = Markup.inlineKeyboard([
    [{ text: '🔐 Maine pay kiya — UTR daalein', callback_data: `wallet_utr_${fee}`, style: 'success' }],
    supportRow(),
    [{ text: '❌ Cancel order', callback_data: `action_cancel_order_confirm_${order.id}`, style: 'danger' }]
  ]);
  const chatId = order.userChatId || order.userId || userId;
  await bot.telegram.sendMessage(chatId, card, { parse_mode: 'HTML', ...kb });
  // Boss ko sach: kis order ka QR held hai aur kitna verification pending hai.
  for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
    await bot.telegram.sendMessage(
      bossId,
      `🧊 <b>QR HELD — verification pending</b>\n` +
      `User: <b>${escapeHtml(walletNameOf(userId, order.userName || ''))}</b> · <code>${escapeHtml(userId)}</code>\n` +
      `Order: <code>#${escapeHtml(String(order.id))}</code> · fee ₹${walletRupees(fee)} · balance ₹${walletRupees(balancePaise || 0)}\n` +
      (upiReady
        ? `<i>QR ban chuka hai aur safe rakha hai — paisa verify hote hi customer ko release ho jayega.</i>`
        : `❌ <b>UPI set nahi hai — customer paisa bhej hi nahi sakta. Pehle UPI daalein.</b>`),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          upiReady
            ? [{ text: '💳 Fee & Wallet', callback_data: 'boss_fee_panel', style: 'primary' }]
            : [{ text: '💳 Payment UPI set karein', callback_data: 'boss_upi_change', style: 'success' }],
          [{ text: '⏳ Pending UTR', callback_data: 'boss_utr_list', style: 'success' }]
        ])
      }
    ).catch(() => {});
  }
  return true;
}

/** QR ban hi nahi paya — koi fee nahi, sirf "try again" + admin option. */
async function sendQrGenerationFailedCard(order, { reason = '' } = {}) {
  const userId = walletOwnerId(order);
  if (!userId) return false;
  const text = formatQrFailedCard({ orderId: order.id, reason });
  const chatId = order.userChatId || order.userId || userId;
  await bot.telegram.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [{ text: '🔄 Shuru se dobara try', callback_data: `simple_restart_order_${order.id}`, style: 'success' }],
      supportRow()
    ])
  }).catch(() => {});
  return true;
}

/** Wallet card + buttons (customer). */
async function sendWalletCard(ctx, { notice = '' } = {}) {
  const userId = String(ctx.from?.id || '');
  const db = getDb();
  const w = ensureWallet(db, userId, {
    name: walletNameOf(userId, ctx.from?.first_name || ''),
    username: ctx.from?.username || ''
  });
  saveDb(db);
  const pending = listTopupRequests(getDb(), { userId, status: TOPUP_STATUS.PENDING, limit: 1 }).length;
  const text = (notice ? `${notice}\n` : '') +
    `👛 <b>Wallet: ₹${walletRupees(w.balancePaise)}</b>\n` +
    `Order fee: ${w.feeExempt || isBoss(userId) ? 'Free' : `₹${walletRupees(feePaiseNow())}`} · Swiggy bill alag hai.` +
    (pending ? `\n⏳ Recharge pending` : '');
  const kb = Markup.inlineKeyboard([
    [{ text: '➕ Add money', callback_data: 'wallet_topup', style: 'success' },
     { text: '🧾 History', callback_data: 'wallet_history', style: 'primary' }],
    [{ text: '◀ Back', callback_data: 'wallet_back_home', style: 'primary' }]
  ]);
  return ctx.reply(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
}

async function sendTopupAmounts(ctx) {
  const fee = feePaiseNow();
  const amounts = [...new Set([fee, ...TOPUP_PRESETS_PAISE])].filter((amount) => Number.isSafeInteger(amount) && amount >= 100);
  const rows = [];
  for (let i = 0; i < amounts.length; i += 2) {
    rows.push(amounts.slice(i, i + 2).map((paise) => ({
      text: `₹${walletRupees(paise)}`, callback_data: `wallet_topup_amt_${paise}`, style: 'success'
    })));
  }
  rows.push([{ text: '✏️ Other amount', callback_data: 'wallet_topup_custom', style: 'primary' }]);
  rows.push([{ text: '◀ Back', callback_data: 'wallet_home', style: 'primary' }]);
  return ctx.reply('➕ <b>Amount chunein</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() => {});
}

async function sendWalletTopupInstructions(ctx, amountPaise) {
  // Same value used by the wallet ledger, Mini App API and UTR payee policy.
  const upi = configuredWalletUpiId(getDb());
  const valid = isValidUpiVpa(upi) && !isPlaceholderUpiId(upi);
  const text = valid
    ? `₹${walletRupees(amountPaise)} wallet ke liye <code>${escapeHtml(upi)}</code> par bhejein.\nSwiggy order payment alag hai. Phir UTR bhejein.`
    : 'Wallet UPI set nahi hai. Admin se baat karein.';
  const rows = valid ? [[{ text: '📝 UTR bhejein', callback_data: `wallet_utr_${amountPaise}`, style: 'success' }]] : [supportRow()];
  rows.push([{ text: '◀ Back', callback_data: 'wallet_topup', style: 'primary' }]);
  return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() => {});
}

bot.command(['wallet', 'balance', 'mybalance'], async (ctx) => {
  await sendWalletCard(ctx).catch(() => {});
});

bot.action('wallet_home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendWalletCard(ctx);
});

bot.action('wallet_back_home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await renderUserCard(ctx, ctx.from.id).catch(() => sendWalletCard(ctx));
});

bot.action('wallet_topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendTopupAmounts(ctx);
});

bot.action(/^wallet_topup_amt_(\d+)$/, async (ctx) => {
  const amountPaise = Number(ctx.match[1] || 0);
  await ctx.answerCbQuery().catch(() => {});
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) {
    return ctx.reply('₹1 ya zyada amount chunein.').catch(() => {});
  }
  return sendWalletTopupInstructions(ctx, amountPaise);
});

bot.action('wallet_topup_custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_wallet_topup_amount' };
  await ctx.reply('Amount bhejein (₹1 ya zyada).', {
    reply_markup: { force_reply: true, input_field_placeholder: 'Amount in ₹' }
  }).catch(() => {});
});

// "Verification karein" — seedha UPI + UTR, bina amount choose kiye.
bot.action('wallet_verify_pay', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendTopupAmounts(ctx);
});

bot.action(/^wallet_utr_(\d+)$/, async (ctx) => {
  const amountPaise = Number(ctx.match[1] || 0);
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) {
    return ctx.answerCbQuery('Amount invalid hai.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_wallet_utr', amountPaise, setAt: Date.now() };
  await ctx.reply(`₹${walletRupees(amountPaise)} payment ka UTR bhejein.`, {
    reply_markup: { force_reply: true, input_field_placeholder: 'UTR / Ref No.' }
  }).catch(() => {});
});

bot.action('wallet_history', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  const entries = walletHistory(getDb(), userId, { limit: 10 });
  await ctx.reply(formatWalletHistory({ entries, limit: 10 }), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[{ text: '◀ Back', callback_data: 'wallet_home', style: 'primary' }]])
  }).catch(() => {});
});

/** A recharge must not silently place an order; the customer taps retry. */
async function resumeOrderAfterTopup(userId) {
  const db = getDb();
  const w = getWallet(db, userId);
  if (!isBoss(userId) && !w?.feeExempt && walletBalancePaise(db, userId) < serviceFeePaiseFor(db)) {
    return { resumed: false, reason: 'balance low' };
  }
  const order = Object.values(db.orders || {}).find(o =>
    String(o?.fwdSenderUserId || o?.userId || '') === String(userId) &&
    !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(o.status || '').toUpperCase()) &&
    ['AWAITING_WALLET', 'AWAITING_FEE', 'QR_HELD'].includes(String(o.cardStage || '').toUpperCase())
  );
  if (!order) return { resumed: false };
  await bot.telegram.sendMessage(String(userId), 'Balance ready. Order ke liye retry dabayein.', {
    ...Markup.inlineKeyboard([[{ text: '🔄 Retry order', callback_data: `user_retry_qr_${order.id}` }]])
  }).catch(() => {});
  return { resumed: false, orderId: order.id, ready: true };
}

// ── 🔐 FEE QR ka payment aaya → auto verify → ORDER QR release ─────────────
// Boss (30-10-2026): "after they pay the fee amount on given qr and utr will auto
// verify and then show them qr". Customer ko koi UTR type karna hi nahi padta:
// auto-verify (webhook / provider) paisa dekhte hi QR release kar deta hai.
bot.action(/^wallet_fee_paid_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const orderId = String(ctx.match[1]);
  const userId = String(ctx.from.id);
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order nahi mila').catch(() => {});
  if (String(order.userId) !== userId && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Ye aapka order nahi').catch(() => {});
  }
  if (!isOrderQrHeld(order)) {
    await ctx.answerCbQuery('QR pehle hi bhej diya gaya hai').catch(() => {});
    return releaseHeldQrToCustomer(orderId, { reason: 'customer tap (already released)' }).catch(() => {});
  }
  order.feePaidReportedAt = new Date().toISOString();
  db.orders[orderId] = order;
  saveDb(db);

  // Auto-verify ON → paisa aate hi (webhook/provider) khud release hoga.
  if (autoVerifyConfigured()) {
    await ctx.answerCbQuery('Payment check ho raha hai…').catch(() => {});
    await ctx.reply(
      '⏳ <b>Payment check ho raha hai</b>\n\n<i>Verify hote hi aapka ORDER QR yahin aa jayega — kuch type nahi karna.</i>',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[{ text: '🔄 Dobara check', callback_data: `wallet_fee_paid_${orderId}`, style: 'primary' }], supportRow()])
      }
    ).catch(() => {});
    // Provider se turant ek check (agar UTR/ref diya gaya ho).
    return;
  }

  // Auto-verify OFF → customer ko atka nahi rakhte: QR release + fee "baad me".
  await ctx.answerCbQuery('Theek hai — QR bhej raha hoon').catch(() => {});
  recordDeferredFee(order, Number(order.feeDuePaise || feePaiseNow()), { reason: 'auto-verify off — customer ne pay bataya' });
  order.feeDeferredNotified = true;
  db.orders[orderId] = order;
  saveDb(db);
  await releaseHeldQrToCustomer(orderId, { reason: 'customer ne fee pay bataya (auto-verify off)' }).catch(() => {});
  for (const bossId of [...new Set((db.config?.bossIds || []).map(String).filter(Boolean))]) {
    await bot.telegram.sendMessage(
      bossId,
      `🧾 <b>FEE BAAD ME</b> · order <code>#${escapeHtml(orderId)}</code>\n` +
      `<i>Customer ne "pay kar diya" bataya. Auto-verify set nahi hai, isliye QR release kar diya — ₹${walletRupees(order.feeDeferredPaise || feePaiseNow())} panel me due hai (UPI statement me check kar lijiye).</i>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '🧮 Wallet & Fee', callback_data: 'boss_fee_panel', style: 'primary' }]]) }
    ).catch(() => {});
  }
});

// ── 🔄 QR ban nahi paya → "something went wrong, shuru se dobara" ──────────
// Boss (30-10-2026): fail par customer ko sirf restart dikhna chahiye.
bot.action(/^simple_restart_order(_([A-Za-z0-9_-]+))?$/, async (ctx) => {
  const userId = String(ctx.from.id);
  const orderId = String(ctx.match[2] || '');
  await ctx.answerCbQuery('Shuru se dobara…').catch(() => {});
  const db = getDb();
  const target = (orderId && db.orders?.[orderId]) || getActiveUserOrder(db, userId) || getSimpleFocusOrder(userId);
  if (target && !isOrderCustomer(target, userId) && !isBoss(userId)) return ctx.reply('Ye aapka order nahi hai.').catch(() => {});
  if (target && hasPossibleSwiggyPlacement(target)) {
    return ctx.reply('Order Swiggy par ho sakta hai. My Orders check karein; dobara order na karein.').catch(() => {});
  }
  if (target && !['COMPLETED', 'DELIVERED'].includes(String(target.status || '').toUpperCase())) {
    const t = db.orders?.[target.id] || target;
    t.status = 'CANCELLED';
    t.cancelledReason = 'QR_GENERATION_FAILED_RESTART';
    t.cancelledAt = new Date().toISOString();
    t.simpleCardDismissed = true;
    db.orders[t.id] = t;
    saveDb(db);
    closeOrderAccountLock(t.id, { reason: 'QR fail — shuru se dobara' }).catch(() => {});
    try { stopOrderTrackingAuto(t.id); } catch {}
  }
  delete userWaitState[userId];
  clearDraft(userId);
  await cleanupUserChat(ctx.telegram, ctx.chat?.id || userId, userId, { deleteCard: true }).catch(() => {});
  userChatCards.delete(String(userId));
  const screen = getUserScreen(userId, ctx.from);
  const sent = await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard }).catch(() => null);
  if (sent) rememberUserCard(userId, sent);
});

// ── 🔄 QR ban nahi paya → customer dobara try kare ─────────────────────────
bot.action(/^user_retry_qr_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const userId = String(ctx.from.id);
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order nahi mila').catch(() => {});
  if (!isOrderCustomer(order, userId) && !isBoss(ctx.from.id)) return ctx.answerCbQuery('Ye aapka order nahi').catch(() => {});
  await ctx.answerCbQuery('Dobara try kar raha hoon…').catch(() => {});
  const res = await approveUserOrderBillAction(userId, orderId).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!res?.ok) {
    // QR fail ya verification due — dono ka apna card ja chuka hai; bas state refresh.
    await updateOrderCards(getDb().orders?.[orderId]).catch(() => {});
  }
});

// ── 🆘 ADMIN SE BAAT (boss: "usko option dena hai you can contact the admin") ─
bot.action('support_contact_admin', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_support_message', setAt: Date.now() };
  await ctx.reply(
    '🆘 <b>ADMIN SE BAAT</b>\n\n' +
    'Apni dikkat ek message me likh bhejein — seedha admin ke paas jayegi aur wo yahin reply karega.\n\n' +
    '<i>Order / payment / QR / kisi bhi cheez me atak gaye ho to bina jhijhak likhein.</i>',
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Apni dikkat likhein…' } }
  ).catch(() => {});
});

// ── Boss: user wallet vault ────────────────────────────────────────────────
async function sendBossWalletList(ctx, { query = '', notice = '' } = {}) {
  const db = getDb();
  const wallets = searchWallets(db, query, { limit: 12 });
  const summary = walletVaultSummary(db);
  const text = (notice ? `${notice}\n\n` : '') + formatBossWalletList({ wallets, summary, query });
  const rows = wallets.map((w) => ([{
    text: `${Number(w.balancePaise || 0) > 0 ? '💰' : '▫'} ${w.name || w.username || w.userId} · ₹${walletRupees(w.balancePaise)}`,
    callback_data: `boss_wallet_view_${w.userId}`,
    style: 'primary'
  }]));
  rows.push([
    { text: '🔎 Search user', callback_data: 'boss_wallet_search', style: 'primary' },
    { text: '⏳ Pending UTR', callback_data: 'boss_utr_list', style: 'success' }
  ]);
  rows.push([{ text: '💳 Wallet UPI', callback_data: 'boss_wallet_upi', style: 'primary' }]);
  rows.push([
    { text: '🧾 Statement', callback_data: 'boss_wallet_statement' },
    { text: '🔎 UTR check', callback_data: 'boss_wallet_utr_lookup' }
  ]);
  rows.push([
    { text: '🧮 Fee & Prices', callback_data: 'boss_fee_panel', style: 'primary' },
    { text: '◀ Boss Panel', callback_data: 'boss_panel_home', style: 'primary' }
  ]);
  return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() => {});
}

bot.action('boss_wallets', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await sendBossWalletList(ctx);
});

bot.action('boss_wallet_statement', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_wallet_statement' };
  await ctx.reply('UPI statement ki lines bhejein (UTR + amount).', { reply_markup: { force_reply: true } }).catch(() => {});
});

bot.action('boss_wallet_utr_lookup', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_utr_lookup' };
  await ctx.reply('UTR bhejein.', { reply_markup: { force_reply: true } }).catch(() => {});
});

bot.action('boss_wallet_upi', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_wallet_upi' };
  await ctx.reply(`Wallet UPI: ${configuredWalletUpiId(getDb())}\nNayi UPI ID bhejein.`, {
    reply_markup: { force_reply: true, input_field_placeholder: 'name@bank' }
  }).catch(() => {});
});

bot.action('boss_wallet_search', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_wallet_search' };
  await ctx.reply('🔎 <b>USER SEARCH</b>\n\nNaam, username, phone ya user id type karein.', {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, input_field_placeholder: 'jaise: Ravi / @ravi / 98765...' }
  }).catch(() => {});
});

bot.action(/^boss_wallet_view_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const wallet = getWallet(db, userId);
  const pending = listTopupRequests(db, { userId, status: TOPUP_STATUS.PENDING, limit: 5 });
  const feeInfo = userFeeSummary(db, userId);
  const text = [
    formatBossWalletUser({
      wallet,
      userId,
      summaryPending: pending.length,
      feePaise: feePaiseNow(),
      history: walletHistory(db, userId, { limit: 6 })
    }),
    '',
    '🧮 <b>ORDER FEE — is user ka hisaab</b>',
    `Orders: <b>${feeInfo.orders}</b> · fee wale: <b>${feeInfo.feeOrders}</b> · fee ka intezaar: <b>${feeInfo.awaiting}</b>`,
    `Charged: <b>₹${walletRupees(feeInfo.chargedPaise)}</b> · refund: ₹${walletRupees(feeInfo.refundedPaise)} · net <b>₹${walletRupees(feeInfo.netPaise)}</b>`,
    `Per order abhi: <b>₹${walletRupees(feePaiseNow())}</b>${feeInfo.feeExempt ? ' · <b>FREE user</b>' : ''}`
  ].join('\n');
  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        { text: '➕ Add balance', callback_data: `boss_wallet_credit_${userId}`, style: 'success' },
        { text: '➖ Deduct', callback_data: `boss_wallet_debit_${userId}`, style: 'danger' }
      ],
      [
        { text: '✉️ Message user', callback_data: `boss_wallet_msg_${userId}`, style: 'primary' },
        { text: '🧾 Fee history', callback_data: `boss_wallet_feehistory_${userId}`, style: 'primary' }
      ],
      [
        { text: wallet?.feeExempt ? '🏷 Free: ON → OFF' : '🎁 Mark free (no fee)', callback_data: `boss_wallet_free_${userId}`, style: 'primary' }
      ],
      pending.length ? [{ text: `⏳ ${pending.length} pending UTR`, callback_data: `boss_wallet_utr_${userId}`, style: 'success' }] : [],
      [
        { text: '🧮 Fee panel', callback_data: 'boss_fee_panel', style: 'primary' },
        { text: '◀ Wallets', callback_data: 'boss_wallets', style: 'primary' }
      ]
    ].filter((row) => row.length))
  }).catch(() => {});
});

bot.action(/^boss_wallet_credit_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_wallet_credit_amount', targetUserId: ctx.match[1] };
  await ctx.reply(`➕ <b>ADD BALANCE</b> — user <code>${escapeHtml(ctx.match[1])}</code>\n\nKitne rupaye add karne hain? (jaise <code>100</code> ya <code>-50</code>)`, {
    parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: '100' }
  }).catch(() => {});
});

bot.action(/^boss_wallet_debit_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_wallet_debit_amount', targetUserId: ctx.match[1] };
  await ctx.reply(`➖ <b>DEDUCT BALANCE</b> — user <code>${escapeHtml(ctx.match[1])}</code>\n\nKitne rupaye katne hain? (jaise <code>15</code>)`, {
    parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: '15' }
  }).catch(() => {});
});

bot.action(/^boss_wallet_free_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.match[1];
  const db = getDb();
  const w = ensureWallet(db, userId);
  const next = !w?.feeExempt;
  setFeeExempt(db, userId, next, { actor: `boss:${ctx.from.id}` });
  saveDb(db);
  await ctx.answerCbQuery(next ? '🎁 Free user — fee nahi lagegi' : 'Fee wapas lagu').catch(() => {});
  await ctx.reply(
    next
      ? `🎁 <b>${escapeHtml(String(w?.name || userId))}</b> ab <b>free user</b> hai — per-order ₹ fee nahi lagegi.`
      : `🏷 <b>${escapeHtml(String(w?.name || userId))}</b> par ab ₹${walletRupees(feePaiseNow())} fee lagi gi.`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '◀ User', callback_data: `boss_wallet_view_${userId}` }]]) }
  ).catch(() => {});
});

// ── 💳 BOSS: PAYMENT UPI PANEL (boss 30-10-2026) ────────────────────────────
// "upi id add karne ka option to de, kaha payment lunga?"
// Ek jagah sab: kaunsi UPI par paisa aayega, set hai ya nahi, aur set/change.
function upiStatusLine() {
  const upi = walletUpiId();
  const fromEnv = !String(getDb().config?.bossUpiId || '').trim() && upi;
  if (!upi) return '⚠️ <b>UPI set nahi hai</b> — QR / verification ka paisa kisi par nahi aa sakta.';
  if (isPlaceholderUpiId(upi)) return `❌ <b>${escapeHtml(upi)}</b> placeholder hai — is QR par paisa nahi aayega. Badlein.`;
  if (!isValidUpiVpa(upi)) return `❌ <b>${escapeHtml(upi)}</b> ka format galat hai — badlein.`;
  return `✅ <b>${escapeHtml(upi)}</b>${fromEnv ? ' <i>(env se — panel me save karo)</i>' : ''}`;
}

function paymentUpiPanelText() {
  const upi = walletUpiId();
  const setOk = Boolean(upi) && !isPlaceholderUpiId(upi) && isValidUpiVpa(upi);
  return [
    '💳 <b>PAYMENT UPI</b>',
    '',
    `Abhi: ${upiStatusLine()}`,
    '',
    '<b>Is UPI par paisa aata hai:</b>',
    '• Order verification / fee (₹' + walletRupees(feePaiseNow()) + ')',
    `• Wallet recharge UPI: <b>${escapeHtml(configuredWalletUpiId(getDb()))}</b>`,
    '<i>Order ka food payment is UPI par NAHI aata — wo Swiggy ke apne QR/link se hi hota hai.</i>',
    '',
    setOk
      ? '<i>Paisa seedha isi UPI par aayega. Change karna ho to neeche badlein.</i>'
      : '<i>Pehle apni asli UPI daalein — jaise name@okaxis ya name@ybl.</i>'
  ].join('\n');
}

function paymentUpiPanelKeyboard() {
  return Markup.inlineKeyboard([
    [{ text: '✍️ UPI set / change karein', callback_data: 'boss_upi_change', style: 'success' }],
    [{ text: '🧾 UTR & Wallet', callback_data: 'boss_wallets', style: 'primary' }],
    [
      { text: '🧮 Fee & Prices', callback_data: 'boss_fee_panel', style: 'primary' },
      { text: '◀ Boss Panel', callback_data: 'boss_panel_home', style: 'primary' }
    ]
  ]);
}

async function sendPaymentUpiPanel(ctx, { notice = '' } = {}) {
  const text = (notice ? `${notice}\n\n` : '') + paymentUpiPanelText();
  return ctx.reply(text, { parse_mode: 'HTML', ...paymentUpiPanelKeyboard() }).catch(() => {});
}

bot.action('boss_upi_panel', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await sendPaymentUpiPanel(ctx);
});

bot.action('boss_upi_change', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_upi', setAt: Date.now() };
  await ctx.reply(
    '💳 <b>UPI ID DAALEIN</b>\n\n' +
    `Abhi: ${upiStatusLine()}\n\n` +
    'Apni asli UPI bhejein — jaise <code>name@okaxis</code> / <code>name@ybl</code> / <code>98765xxxxx@paytm</code>.\n' +
    '<i>Swiggy ka merchant ID / placeholder reject ho jayega (us QR par paisa nahi aata).</i>',
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'name@okaxis' } }
  ).catch(() => {});
});

// ── 🧮 BOSS: FEE & PRICES PANEL (boss 30-10-2026) ──────────────────────────
// "mujhe order par kitna lena hai uska bhi pannel — ek button wallet and fee,
//  jab uspar click karu to sab dikh jaye: order kitne ka rakha hu, change karna
//  hai ya nahi, user kitne hain, kiska kitna fee, history, usko message."
async function sendBossFeePanel(ctx, { notice = '' } = {}) {
  const db = getDb();
  const summary = feeControlSummary(db);
  const text = (notice ? `${notice}\n\n` : '') + formatFeeControlPanel({ summary }) +
    `\n\n💳 <b>Payment UPI:</b> ${upiStatusLine()}`;
  const presets = [0, 500, 1000, 1500, 2000, 5000];
  const rows = [];
  for (let i = 0; i < presets.length; i += 3) {
    rows.push(presets.slice(i, i + 3).map((paise) => ({
      text: `${Number(summary.feePaise) === paise ? '✅ ' : ''}₹${walletRupees(paise)}`,
      callback_data: `boss_fee_set_${paise}`,
      style: Number(summary.feePaise) === paise ? 'success' : 'primary'
    })));
  }
  rows.push([
    { text: '✍️ Apni fee likho', callback_data: 'boss_fee_custom', style: 'success' },
    { text: '💳 Payment UPI', callback_data: 'boss_upi_panel', style: 'primary' }
  ]);
  rows.push([
    { text: '👥 Users', callback_data: 'boss_wallets', style: 'primary' },
    { text: '⏳ Pending UTR', callback_data: 'boss_utr_list', style: 'success' }
  ]);
  // 🧾 Baad me lene wali fee — ek tap me "le liya" (boss 30-10-2026).
  const deferred = Object.values(db.orders || {})
    .filter((o) => Number(o?.feeDeferredPaise || 0) > 0)
    .sort((a, b) => String(b.feeDeferredAt || '').localeCompare(String(a.feeDeferredAt || '')))
    .slice(0, 5);
  for (const o of deferred) {
    rows.push([{
      text: `✅ Le liya — #${String(o.id).slice(-8)} · ₹${walletRupees(o.feeDeferredPaise)}`,
      callback_data: `boss_fee_deferred_ok_${o.id}`,
      style: 'success'
    }]);
  }
  rows.push([{ text: '◀ Boss Panel', callback_data: 'boss_panel_home', style: 'primary' }]);
  return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() => {});
}

bot.action('boss_fee_panel', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await sendBossFeePanel(ctx);
});

bot.action(/^boss_fee_set_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const paise = Number(ctx.match[1]);
  const db = getDb();
  const res = setServiceFeePaise(db, paise, { actor: `boss:${ctx.from.id}` });
  if (res.ok) saveDb(db);
  await ctx.answerCbQuery(res.ok ? `Fee ₹${walletRupees(paise)}` : 'Nahi hua').catch(() => {});
  await sendBossFeePanel(ctx, {
    notice: res.ok
      ? `✅ <b>Ab har order par ₹${walletRupees(paise)}</b> liya jayega.${paise === 0 ? ' (free)' : ''}\n<i>Purane orders par asar nahi — sirf naye QR par.</i>`
      : `❌ ${escapeHtml(res.reason || res.code || 'error')}`
  });
});

// Boss ne deferred fee cash/UPI me le li — due clear.
bot.action(/^boss_fee_deferred_ok_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const orderId = ctx.match[1];
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order nahi mila').catch(() => {});
  const res = settleDeferredFee(db, order, order.userId || '', { actor: `boss:${ctx.from.id}` });
  if (res.ok) {
    db.orders[orderId] = order;
    saveDb(db);
  }
  await ctx.answerCbQuery(res.ok ? `₹${walletRupees(res.feePaise)} settled` : 'Kuch due nahi').catch(() => {});
  await sendBossFeePanel(ctx, {
    notice: res.ok
      ? `✅ <b>#${escapeHtml(String(orderId))}</b> ki ₹${walletRupees(res.feePaise)} fee settled (aapne le li).`
      : `ℹ️ Is order par koi deferred fee nahi hai.`
  });
});

bot.action('boss_fee_custom', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_fee_amount' };
  await ctx.reply(
    `✍️ <b>FEE SET KAREIN</b>\n\nAbhi: <b>₹${walletRupees(feePaiseNow())}</b> per order\n\n` +
    `Kitne rupaye per order lena hai? (jaise <code>15</code>, <code>20</code>, ya <code>0</code> = free)`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: '15' } }
  ).catch(() => {});
});

bot.action(/^boss_wallet_msg_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_user_message', targetUserId: userId };
  await ctx.reply(
    `✉️ <b>MESSAGE USER</b> — <code>${escapeHtml(userId)}</code>\n\n` +
    `Jo message bhejna hai likhein — user ko seedha Telegram par milega (aapka naam "Admin" dikhega).`,
    { parse_mode: 'HTML', reply_markup: { force_reply: true, input_field_placeholder: 'Message…' } }
  ).catch(() => {});
});

bot.action(/^boss_wallet_feehistory_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const userId = ctx.match[1];
  await ctx.answerCbQuery().catch(() => {});
  const db = getDb();
  const orders = Object.values(db.orders || {})
    .filter((o) => String(o?.userId || '') === userId && Number(o?.feeChargedPaise || 0) > 0)
    .sort((a, b) => new Date(b.feeChargedAt || b.createdAt || 0) - new Date(a.feeChargedAt || a.createdAt || 0))
    .slice(0, 12);
  const feeInfo = userFeeSummary(db, userId);
  const lines = [
    `🧾 <b>FEE HISTORY</b> — <code>${escapeHtml(userId)}</code>`,
    '',
    `Net fee: <b>₹${walletRupees(feeInfo.netPaise)}</b> · orders: ${feeInfo.orders} · refund: ₹${walletRupees(feeInfo.refundedPaise)}`,
    ''
  ];
  if (!orders.length) {
    lines.push('<i>Abhi koi fee wala order nahi.</i>');
  } else {
    for (const o of orders) {
      const charged = Number(o.feeChargedPaise || 0);
      const refunded = Number(o.feeRefundedPaise || 0);
      const when = String(o.feeChargedAt || o.createdAt || '').slice(0, 16).replace('T', ' ');
      lines.push(
        `• <code>#${escapeHtml(String(o.id))}</code> · ₹${walletRupees(charged)}` +
        (refunded > 0 ? ` <i>(refund ₹${walletRupees(refunded)})</i>` : '') +
        `${isOrderPlaced(o) ? ' · placed' : ' · not placed'} · ${escapeHtml(when)}`
      );
    }
  }
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[{ text: '◀ User', callback_data: `boss_wallet_view_${userId}`, style: 'primary' }]])
  }).catch(() => {});
});

bot.action('boss_utr_list', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const requests = listTopupRequests(getDb(), { status: TOPUP_STATUS.PENDING, limit: 10 });
  const text = formatPendingUtrs({ requests, limit: 10 });
  const rows = requests.slice(0, 10).flatMap((r) => ([
    [
      { text: `✅ ${r.name || r.userId} ₹${walletRupees(r.claimedPaise)}`, callback_data: `boss_utr_ok_${r.id}`, style: 'success' },
      { text: '❌', callback_data: `boss_utr_no_${r.id}`, style: 'danger' }
    ],
    [{ text: '✏️ Actual amount', callback_data: `boss_utr_amount_${r.id}` }]
  ]));
  rows.push([{ text: '◀ Wallets', callback_data: 'boss_wallets', style: 'primary' }]);
  await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() => {});
});

bot.action(/^boss_wallet_utr_(\d+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const requests = listTopupRequests(getDb(), { userId: ctx.match[1], status: TOPUP_STATUS.PENDING, limit: 6 });
  const rows = requests.map((r) => ([
    { text: `✅ ₹${walletRupees(r.claimedPaise)} · ${r.utr}`, callback_data: `boss_utr_ok_${r.id}`, style: 'success' },
    { text: '❌', callback_data: `boss_utr_no_${r.id}`, style: 'danger' }
  ]));
  rows.push([{ text: '◀ User', callback_data: `boss_wallet_view_${ctx.match[1]}`, style: 'primary' }]);
  await ctx.reply(formatPendingUtrs({ requests, limit: 6 }), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() => {});
});

async function completeBossTopupApproval(ctx, requestId, approvedPaise = null) {
  const db = getDb();
  const req = db.config?.topupRequests?.[requestId];
  const result = approveTopupRequest(db, requestId, { actor: `boss:${ctx.from.id}`, approvedPaise });
  if (!result.ok || !req) return ctx.reply(`Approve nahi hua: ${result.code}`).catch(() => {});
  if (!saveDbDurable(db)) return ctx.reply('Approval save nahi hua. Admin panel me check karein.').catch(() => {});
  backupMoneyNow().catch(() => {});
  const uid = String(req.userId);
  await bot.telegram.sendMessage(uid, `✅ ₹${walletRupees(req.approvedPaise)} wallet me added. Balance ₹${walletRupees(result.balancePaise)}.`).catch(() => {});
  await resumeOrderAfterTopup(uid).catch(() => null);
  return ctx.reply(`✅ UTR ${req.utr} · ₹${walletRupees(req.approvedPaise)} added.`, {
    ...Markup.inlineKeyboard([[{ text: '◀ Pending UTR', callback_data: 'boss_utr_list' }]])
  }).catch(() => {});
}

bot.action(/^boss_utr_ok_(tu_[A-Za-z0-9_]+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  return completeBossTopupApproval(ctx, ctx.match[1]);
});

bot.action(/^boss_utr_amount_(tu_[A-Za-z0-9_]+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const requestId = ctx.match[1];
  const req = getDb().config?.topupRequests?.[requestId];
  if (!req || req.status !== TOPUP_STATUS.PENDING) return ctx.answerCbQuery('Request pending nahi hai.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  userWaitState[ctx.from.id] = { action: 'waiting_boss_utr_amount', requestId };
  await ctx.reply(`UTR ${req.utr}: bank me mila actual amount bhejein (₹).`, {
    reply_markup: { force_reply: true, input_field_placeholder: 'Actual amount' }
  }).catch(() => {});
});

bot.action(/^boss_utr_no_(tu_[A-Za-z0-9_]+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized').catch(() => {});
  const db = getDb();
  const req = db.config?.topupRequests?.[ctx.match[1]];
  const res = rejectTopupRequest(db, ctx.match[1], { actor: `boss:${ctx.from.id}`, reason: 'Boss ko UPI me payment nahi mila' });
  if (res.ok && !saveDbDurable(db)) return ctx.answerCbQuery('Save nahi hua.', { show_alert: true }).catch(() => {});
  if (res.ok) backupMoneyNow().catch(() => {});
  await ctx.answerCbQuery(res.ok ? '❌ Reject kar diya' : `❌ ${res.code}`).catch(() => {});
  if (!res.ok || !req) return;
  await bot.telegram.sendMessage(
    String(req.userId),
    `❌ <b>UTR verify nahi hua</b>\n\n` +
    `<i>UTR <code>${escapeHtml(req.utr)}</code> ke against payment nahi mila. Agar paisa kata hai to UTR dobara check karke bhejein, ya Boss se baat karein — balance haath se bhi add ho sakta hai.</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  await ctx.reply(`❌ Rejected · <code>${escapeHtml(req.utr)}</code> · user <b>${escapeHtml(req.name || req.userId)}</b> ko bataya gaya.`, { parse_mode: 'HTML' }).catch(() => {});
});

// ── 📱 CUSTOMER PHONE LOGIN HANDOVER (boss 29-10-2026) ──────────────────────
// Customer ke phone par wahi ID login ho aur order wahin se ho. Bot jhooth nahi
// bolta: "login ho gaya" sirf tab jab Swiggy ka live check pass ho, aur "pakka"
// tab jab us ID par naya order dikhe.
async function loadDeviceLoginOrder(ctx) {
  const orderId = String(ctx.match?.[1] || '');
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) {
    await ctx.answerCbQuery('Order nahi mila.', { show_alert: true }).catch(() => {});
    return null;
  }
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    await ctx.answerCbQuery('Ye order aapka nahi hai.', { show_alert: true }).catch(() => {});
    return null;
  }
  return order;
}

bot.action(/^devlogin_check_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const order = await loadDeviceLoginOrder(ctx);
  if (!order) return;
  await ctx.answerCbQuery('Swiggy se live check kar raha hoon…').catch(() => {});
  // Customer ka bayan note karo — par "verified" tabhi jab probe pass ho.
  markCustomerSaidLoggedIn(order);
  const res = await refreshDeviceLoginTruth(order.id).catch((err) => ({ ok: false, reason: err?.message || 'probe fail' }));
  const fresh = getDb().orders?.[order.id] || order;
  const text = res?.ok
    ? buildDeviceLoginStatusText({ order: fresh, probe: res.probe, escape: escapeHtml })
    : `❌ <b>CHECK FAIL</b>\n<i>${escapeHtml(String(res?.reason || 'verify nahi ho paya'))}</i>`;
  const cb = deviceLoginCallbacks(order.id);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [{ text: '🔁 Dobara check', callback_data: cb.check }, { text: '❓ Madad', callback_data: cb.help }]
    ])
  }).catch(() => {});
  try { await updateOrderCards(getDb().orders?.[order.id] || order); } catch {}
});

bot.action(/^devlogin_phone_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const order = await loadDeviceLoginOrder(ctx);
  if (!order) return;
  await ctx.answerCbQuery('Theek hai — order aapke phone se hoga').catch(() => {});
  const db = getDb();
  const accKey = order.selectedAccount || order.deviceLogin?.accountKey || '';
  const acc = accKey ? db.config?.accounts?.[accKey] : null;
  if (acc) attachDeviceLogin(order, acc, { key: accKey });
  customerChoseOwnPhone(order);
  db.orders[order.id] = order;
  saveDb(db);

  const res = await refreshDeviceLoginTruth(order.id).catch(() => ({ ok: false }));
  const fresh = getDb().orders?.[order.id] || order;
  const cb = deviceLoginCallbacks(order.id);
  // Boss ko bhi (standing rule: har cheez dono ko) — customer reply mirror se
  // jata hai, par yeh decision boss ke apne panel me bhi dikhna chahiye.
  for (const bossId of [...new Set((db.config?.bossIds || []).map(String).filter(Boolean))]) {
    if (String(bossId) === String(ctx.chat?.id)) continue;
    await bot.telegram.sendMessage(
      bossId,
      `📱 <b>CUSTOMER PHONE PLACEMENT ON</b> · order <code>#${escapeHtml(String(order.id))}</code>\n` +
      `Swiggy ID: <code>${escapeHtml(String(fresh.deviceLogin?.phone || order.orderAccount || ''))}</code>\n` +
      `<i>Ab bot apni taraf se place nahi karega — order customer ke phone se hoga (offers usi ID par lage hain).</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
  // 📱 Asli steps jo phone me login karate hain (bot khud login nahi kar sakta).
  const loginCard = buildPhoneLoginCard({ order: fresh, account: acc, key: accKey });
  await ctx.reply(loginCard.text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(loginCard.buttons)
  }).catch(() => {});
  await ctx.reply(buildDeviceLoginStatusText({ order: fresh, probe: res?.probe || null, escape: escapeHtml }), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [{ text: '✅ Login ho gaya — check karo', callback_data: cb.check }],
      [{ text: '❓ Madad', callback_data: cb.help }]
    ])
  }).catch(() => {});
  try { await updateOrderCards(getDb().orders?.[order.id] || order); } catch {}
});

bot.action(/^devlogin_help_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const order = await loadDeviceLoginOrder(ctx);
  if (!order) return;
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(buildDeviceLoginHelpText({ order }), { parse_mode: 'HTML' }).catch(() => {});
});

// 📱 Phone me login hua ya nahi — cart dikhne se pata chalta hai.
// Bot phone ko dekh nahi sakta, isliye "self-report" hi rakha jata hai (jhooth
// nahi: pakka saboot us ID par naye order se milta hai).
function mirrorPhoneLoginToBoss(order, line) {
  try {
    const db = getDb();
    for (const bossId of [...new Set((db.config?.bossIds || []).map(String).filter(Boolean))]) {
      bot.telegram.sendMessage(
        bossId,
        line +
        `\n▪ Order: <code>#${escapeHtml(String(order.id))}</code> · ID: <code>${escapeHtml(String(order.deviceLogin?.phone || order.orderAccount || ''))}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch { /* mirror optional, sach important */ }
}

bot.action(/^devlogin_cart_yes_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const order = await loadDeviceLoginOrder(ctx);
  if (!order) return;
  await ctx.answerCbQuery('Theek hai — aapke phone me cart dikh raha hai').catch(() => {});
  const db = getDb();
  notePhoneCartSeen(order);
  db.orders[order.id] = order;
  saveDb(db);
  await ctx.reply(
    '✅ <b>Aapke phone me cart dikh raha hai</b> (aapne bataya — login ho gaya).\n\n' +
    '<i>Ab app se cart khol kar order place kar dein — us ID par order aate hi bot tracking + OTP khud laga dega.</i>\n\n' +
    '<i>Bot ka pakka saboot us ID par naye order se milega.</i>',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '📦 Meri orders', url: 'https://www.swiggy.com/my-account/orders' }]]) }
  ).catch(() => {});
  mirrorPhoneLoginToBoss(order, '✅ <b>CUSTOMER PHONE LOGIN — CART DIKHA</b>\n<i>Sach: customer ne apne phone me cart dekha (self-report). Pakka proof us ID par naye order se.</i>');
  try { await updateOrderCards(getDb().orders?.[order.id] || order); } catch {}
});

bot.action(/^devlogin_cart_no_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const order = await loadDeviceLoginOrder(ctx);
  if (!order) return;
  await ctx.answerCbQuery('Koi baat nahi — chalo dobara').catch(() => {});
  const db = getDb();
  notePhoneCartMissing(order);
  db.orders[order.id] = order;
  saveDb(db);
  const accKey = order.selectedAccount || order.deviceLogin?.accountKey || '';
  const acc = accKey ? db.config?.accounts?.[accKey] : null;
  const card = buildPhoneLoginCard({ order, account: acc, key: accKey });
  await ctx.reply(
    '❌ <b>Cart nahi dikha = us phone me login nahi hua.</b>\n\n' +
    '<i>Wajah aam taur par: purani ID pehle se login hai, ya OTP wale number wala phone paas nahi hai.</i>\n\n' +
    '<b>Sabse aasan:</b> “🙅 OTP nahi — bot khud kare” dabaiye — bot order khud place kar dega, aapko kuch nahi karna.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [{ text: '🙅 OTP nahi — bot khud kare', callback_data: card.callbacks.botPlaces, style: 'success' }],
        [{ text: '📲 Swiggy app kholo', url: 'https://www.swiggy.com/' }]
      ])
    }
  ).catch(() => {});
  mirrorPhoneLoginToBoss(order, '❌ <b>CUSTOMER PHONE LOGIN — CART NAHI DIKHA</b>\n<i>Us phone me login nahi hua. Bot khud place kar sakta hai.</i>');
  try { await updateOrderCards(getDb().orders?.[order.id] || order); } catch {}
});

// 🙅 "OTP nahi ho payega" — sabse aam case (burhe Ammi/Abbu, boss bahar).
// Bot wapas apni taraf se order karta hai: ghar me kisi ko kuch nahi karna.
bot.action(/^devlogin_bot_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const order = await loadDeviceLoginOrder(ctx);
  if (!order) return;
  await ctx.answerCbQuery('Theek hai — bot khud order karega').catch(() => {});
  const db = getDb();
  chooseBotPlacement(order);
  db.orders[order.id] = order;
  saveDb(db);
  await ctx.reply(
    `🙅 <b>OTP SKIP — BOT KHUD ORDER KAREGA</b>\n\n` +
    `Swiggy ID: <code>${escapeHtml(String(order.deviceLogin?.phone || order.orderAccount || ''))}</code>\n` +
    `<i>Ghar me kisi ko phone/OTP kuch nahi karna. Order usi ID se place hoga jispar ₹50 cash laga hua hai — ` +
    `aap sirf payment/QR kar dena, tracking + delivery OTP bot bhej dega.</i>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
  try { await updateOrderCards(getDb().orders?.[order.id] || order); } catch {}
});

bot.action(SIMPLE_CHAT_CALLBACKS.myOrder, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handlePreviousOrder(ctx);
});

// CONSENT: this single tap is the customer's approval. It is stored on the order
// (who / when / amount / channel) before any payment QR is created.
// 📱 LOGIN BUTTON (boss 30-10-2026) — cart+address paste ke baad customer ko
// sirf yahi ek button dikhta hai: "ID apne phone me login karne ke liye ye
// button dabaye". Dabate hi ID handover record hoti hai aur BILL + QR ka option
// aata hai. Iske baad sirf: bill → QR (fee) → "sab ho gaya".
bot.action(SIMPLE_CHAT_CALLBACKS.loginReady, async (ctx) => {
  const userId = String(ctx.from.id);
  await ctx.answerCbQuery('Bill taiyar kar raha hoon…').catch(() => {});
  const db = getDb();
  const draft = getDraft(userId);
  const active = getActiveUserOrder(db, userId);
  if (!active) {
    if (!draft?.cart || !draft?.address) {
      return renderUserCard(ctx, userId).catch(() => {});
    }
    // Login ho gaya → ab order/bill shuru (aur uske baad sirf QR).
    const started = await startSimpleOrderFromDraft(ctx, userId);
    const fresh2 = started ? getActiveUserOrder(getDb(), userId) : null;
    if (!fresh2) return renderUserCard(ctx, userId).catch(() => {});
    return;
  }

  // ⚠️ Boss (29-10-2026): "JSON user ke phone me login nahi ho raha, mere phone me
  // login ho raha" — pehle yahan `customerChoseOwnPhone()` lagta tha, jisse
  // placementMode CUSTOMER_PHONE ho jata tha aur payment stage "order aapke phone
  // se karo" bolta tha (jabki phone me login hua hi nahi tha) → order kahin nahi
  // jata tha. Ab: yeh button SIRF handover note karta hai; order bot hi place
  // karega (default, bina OTP). Customer khud karna chahe to uska alag button hai.
  const accKey = active.selectedAccount || active.deviceLogin?.accountKey || '';
  const acc = accKey ? db.config?.accounts?.[accKey] : null;
  if (acc) {
    attachDeviceLogin(active, acc, { key: accKey });
    markHandoverSent(active);
    const fresh = getDb();
    fresh.orders[active.id] = active;
    saveDb(fresh);
  }

  // Bill ready? Seedha bill card (bill + "✅ QR banao") — koi extra screen nahi.
  const card = buildSimpleOrderCard(getDb().orders?.[active.id] || active);
  await ctx.reply(card.text, { parse_mode: 'HTML', ...card.keyboard }).catch(() => {});
});

bot.action(/^simple_login_help_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const orderId = String(ctx.match[1]);
  const userId = String(ctx.from.id);
  const order = getDb().orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order nahi mila').catch(() => {});
  if (!isOrderCustomer(order, userId) && !isBoss(userId)) {
    return ctx.answerCbQuery('Ye aapka order nahi').catch(() => {});
  }
  await ctx.answerCbQuery().catch(() => {});
  const help = buildSimpleLoginHelpCard(order);
  await ctx.reply(help.text, { parse_mode: 'HTML', ...help.keyboard }).catch(() => {});
});

bot.action(/^simple_confirm_order_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const userId = ctx.from.id;
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  if (!isOrderCustomer(order, userId) && !isBoss(userId)) {
    return ctx.answerCbQuery('Unauthorized: this is not your order.', { show_alert: true }).catch(() => {});
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return ctx.answerCbQuery('This order is already closed.', { show_alert: true }).catch(() => {});
  }

  // Inject session into customer order context on bill approval:
  injectAccountSessionIntoOrder(order);

  if (!order.customerConsentGiven) {
    Object.assign(order, buildConsentPatch(order, userId));
    order.simpleChat = true;
    db.orders[orderId] = order;
    saveDb(db);
  }

  await ctx.answerCbQuery('✅ Order confirmed').catch(() => {});

  // Bill already computed and awaiting approval -> straight to the Swiggy payment QR.
  if (order.status === 'APPROVAL_PENDING' || order.status === 'PAYMENT_PENDING') {
    const res = await approveUserOrderBillAction(String(userId), orderId);
    // Fee QR / fail card / retry card already apna saaf message bhej chuke hain —
    // unke upar raw error nahi.
    const alreadyExplained = ['SERVICE_FEE_DUE', 'QR_GENERATION_FAILED', 'WALLET_LOW_BALANCE', 'PLACEMENT_OUTCOME_UNKNOWN'].includes(String(res?.code || ''));
    if (!res?.ok && !alreadyExplained) {
      await ctx.reply(`! ${escapeHtml(res?.error || 'Payment QR abhi nahi ban paya.')}`).catch(() => {});
    }
    await updateOrderCards(getDb().orders?.[orderId] || order).catch(() => {});
    return;
  }

  // Still scanning -> mark consent, the auto-approve hook sends the QR the moment
  // the max-offer bill is ready. No second confirmation is asked.
  await ctx.editMessageText(
    '✅ <b>Confirm ho gaya</b>\n\n<i>Best price lag raha hai — QR yahin aa jayega.</i>',
    { parse_mode: 'HTML' }
  ).catch(() => {});
  autoOptimizeUserOrder(orderId, { reason: 'CUSTOMER_CONFIRM' }).catch((err) =>
    console.error(`[SimpleChat] optimize after confirm failed for #${orderId}:`, err?.message || err)
  );
});

bot.action(SIMPLE_CHAT_CALLBACKS.confirmDraft, async (ctx) => {
  const userId = ctx.from.id;
  const draft = getDraft(userId);
  if (!draft?.cart || !draft?.address) {
    return ctx.answerCbQuery('Cart + address link chahiye.', { show_alert: true }).catch(() => {});
  }
  updateDraft(userId, buildConsentPatch({}, userId));
  await ctx.answerCbQuery('✅ Order confirmed').catch(() => {});
  await startSimpleOrderFromDraft(ctx, userId);
});

bot.action(['action_send_to_admin', 'action_send_to_boss', 'action_send_to_beta', 'action_send_order_to_beta'], async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleSendToBoss(ctx);
});

bot.action('action_cancel_order_confirm', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCancelOrderConfirm(ctx);
});

bot.action(/^action_cancel_order_confirm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const orderId = ctx.match[1];
  await handleCancelOrderConfirm(ctx, orderId);
});

// Progressive 4-Topic progression actions for Ammi & Abbu
bot.action(/^topic_nav_(\d)_(.+)$/, async (ctx) => {
  const targetTopic = ctx.match[1];
  const orderIdArg = ctx.match[2];
  await handleTopicNavClick(ctx, targetTopic, orderIdArg, {
    getUserScreenFn: getUserScreen,
    formatUserOrderCardFn: formatUserOrderCard
  });
});

bot.action('topic_finish_and_start', async (ctx) => {
  const userId = ctx.from.id;
  resetOrderTopicsToStart(userId);
  userChatCards.delete(String(userId));
  await ctx.answerCbQuery('✓ Sab topics complete! Naya order shuru (Topic 1: Submit Link)').catch(() => {});
  const screen = getUserScreen(userId, ctx.from);
  try {
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

bot.hears(['🛒 Start New Order', '🛒 New Order', 'Start New Order', 'New Order', 'Naya Order', '🛒 Naya Order', 'Naya Order Shuru Karein'], async (ctx) => {
  const userId = ctx.from.id;
  resetOrderTopicsToStart(userId);
  userChatCards.delete(String(userId));
  const screen = getUserScreen(userId, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action(/^user_confirm_cancel_(.+)$/, async (ctx) => {
  const target = ctx.match[1];
  const userId = ctx.from.id;

  if (target === 'draft') {
    clearDraft(userId);
    userChatCards.delete(String(userId));
    const screen = getUserScreen(userId, ctx.from);
    await ctx.answerCbQuery('Draft Cleared').catch(() => {});
    try {
      await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    } catch (e) {
      await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    }
    return;
  }

  const db = getDb();
  const order = db.orders[target];
  if (!order) {
    return ctx.answerCbQuery('Order not found', { show_alert: true }).catch(() => {});
  }

  // Security check: Must be the order's customer or boss
  if (Number(order.userId) !== Number(userId) && !isBoss(userId)) {
    return ctx.answerCbQuery('Unauthorized: Not your order', { show_alert: true }).catch(() => {});
  }

  if (hasPossibleSwiggyPlacement(order)) {
    return ctx.answerCbQuery('Order Swiggy par ho sakta hai. Original Swiggy account me check/cancel karein; bot se cancel nahi hua.', { show_alert: true }).catch(() => {});
  }

  // State machine transition check
  if (!canTransitionOrder(order.status, 'CANCELLED')) {
    return ctx.answerCbQuery(`Cannot cancel: order is already ${order.status}`, { show_alert: true }).catch(() => {});
  }

  order.status = 'CANCELLED';
  order.cancelledAt = new Date().toISOString();
  saveDb(db);
  try { stopOrderTrackingAuto(order.id); } catch {}
  clearDraft(userId);

  await ctx.answerCbQuery('Order Cancelled ●').catch(() => {});

  // 1. Delete message from current chat
  try {
    await ctx.deleteMessage();
  } catch (e) {}

  // 2. Delete card messages from user and boss chats
  await deleteOrderMessages(order);
  userChatCards.delete(String(userId));

  // 3. Notify bosses with View Cancelled Orders button
  for (const bossId of db.config.bossIds) {
    try {
      const userProfileUrl = `tg://user?id=${order.userId}`;
      await bot.telegram.sendMessage(
        bossId,
        `● <b><a href="${userProfileUrl}">${escapeHtml(order.userName)}</a> ne Order #${order.id} CANCEL kar diya hai!</b>\n` +
        `# <b>User TG ID:</b> <a href="${userProfileUrl}">${order.userId}</a>\n\n` +
        `<i>Card chat se delete kar diya gaya hai.</i>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('× View Cancelled Orders', 'boss_view_cancelled_orders')]
          ])
        }
      );
    } catch (e) {}
  }

  await ctx.reply('× <b>Order cancel ho gaya aur message delete kar diya gaya hai!</b>\n\nAap naya order bhej sakte hain.', { parse_mode: 'HTML' });
  const screen = getUserScreen(userId, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action(/^user_keep_order_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Order active hai ●').catch(() => {});
  const userId = ctx.from.id;
  const screen = getUserScreen(userId, ctx.from);
  try {
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

bot.action('action_previous_order', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handlePreviousOrder(ctx);
});

bot.action('user_back_to_main', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  if (isBoss(userId)) {
    const home = getBossPanelHome();
    await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
  } else {
    const screen = getUserScreen(userId, ctx.from);
    try {
      await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    } catch (e) {
      await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
    }
  }
});

bot.action(/^user_call_partner_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  const order = lookupOrder(db, orderId);
  if (!order) return ctx.answerCbQuery('Order not found.').catch(() => {});
  const partnerName = order.deliveryBoyName || 'Delivery Partner';
  const partnerPhone = order.deliveryBoyMobile || '';
  if (!partnerPhone) {
    return ctx.answerCbQuery('Partner contact number is not available yet.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery(`🛵 ${partnerName}\n📞 Call: ${partnerPhone}`, { show_alert: true }).catch(() => {});
});

bot.action(/^user_refresh_status_(.+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, orderId);

  if (!order) { console.warn('[OrderLookup] miss', orderNotFoundDiag(db, orderId)); return ctx.answerCbQuery('Order not found — ' + orderNotFoundDiag(db, orderId)).catch(() => {}); }
  await ctx.answerCbQuery('Status Refreshed ↻').catch(() => {});

  // If live order has a Swiggy order ID and is not terminal, trigger an active status update scan:
  if (order.swiggyOrderId && !isTerminalDeliveryStatus(order.liveOrderStatus)) {
    ensureOrderTracking(order.id, { budgetMs: 12000, deep: true, force: true }).then(() => {
      const refreshed = getDb().orders?.[orderId];
      if (refreshed) updateOrderCards(refreshed).catch(() => {});
    }).catch(() => {});
  }

  const card = customerOrderCard(order);
  try {
    await ctx.editMessageText(card.text, { parse_mode: 'HTML', ...card.keyboard });
  } catch (e) {}

  // Customer can retry the account / max-offer scan straight from their card.
  if (
    !order.isForwardedOrder &&
    !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status) &&
    (!order.selectedAccount || !(Number(order.finalPayable || 0) > 0))
  ) {
    autoOptimizeUserOrder(orderId, { reason: 'CUSTOMER_REFRESH_STATUS' }).catch(err =>
      console.error(`[AutoOptimize] refresh retry failed for #${orderId}:`, err?.message || err)
    );
  }
});

bot.action('user_reset', async (ctx) => {
  await ctx.answerCbQuery('Form cleared').catch(() => {});
  clearDraft(ctx.from.id);
  const screen = getUserScreen(ctx.from.id, ctx.from);
  try {
    await ctx.editMessageText(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  } catch (e) {
    await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
  }
});

// ================= SWIGGY WORLD BOT FEATURES =================

// 1. Saved Addresses
async function handleSavedAddresses(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    const anyLoggedIn = Object.entries(db.config?.accounts || {})
      .filter(([, a]) => a && a.isLoggedIn && (a.cookies || a.tid));
    if (anyLoggedIn.length === 0) {
      return ctx.reply(
        '! <b>Koi Swiggy account logged in nahi hai</b> — saved addresses dikhane ke liye pehle account login karein.',
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[
          Markup.button.callback('☎ Login with Number', 'boss_login_with_number'),
          Markup.button.callback('◉ Connected Accounts', 'boss_view_accounts')
        ]]) }
      );
    }
    return ctx.reply(
      `! <b>${escapeHtml(acc?.name || activeKey || 'Active account')} is not logged in!</b>\n\n` +
      `<i>${anyLoggedIn.length} aur account logged in hain — unme se koi chunein.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(
          anyLoggedIn.slice(0, 6).map(([key, a]) => ([
            Markup.button.callback(`⌖ ${a.name || a.phone || key}`, `acc_view_addrs_${key}`)
          ]))
        )
      }
    );
  }

  const waitMsg = await ctx.reply(`⌕ <i>Fetching saved addresses from ${escapeHtml(acc.name || activeKey)}'s Swiggy account...</i>`, { parse_mode: 'HTML' });
  const addresses = await fetchAccountAddresses(acc);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  if (!addresses || addresses.length === 0) {
    return ctx.reply(`⌖ <b>No saved addresses found in ${acc.name || activeKey}'s account.</b>`, { parse_mode: 'HTML' });
  }

  let text = `<b>Saved Addresses</b>\n\n`;
  for (const addr of addresses) {
    text += `<b>${escapeHtml(addr.city)} Address</b>\n` +
      `${escapeHtml(addr.name)} <code>${escapeHtml(addr.mobile)}</code>\n` +
      `${escapeHtml(addr.address)}\n` +
      `Latitude: ${addr.lat}\n` +
      `Longitude: ${addr.lng}\n\n`;
  }

  const buttons = [
    [Markup.button.callback('↻ Refresh Addresses', `acc_view_addrs_${activeKey}`)],
    [Markup.button.callback('◉ Switch Account', 'acc_refresh_list')]
  ];

  await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
}

bot.command('addresses', async (ctx) => handleSavedAddresses(ctx));
bot.action('action_refresh_addresses', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleSavedAddresses(ctx);
});
bot.action(/^acc_view_addrs_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handleSavedAddresses(ctx, key);
});

// 2. My Swiggy Accounts Menu
async function handleMyAccounts(ctx) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const accounts = db.config?.accounts || {};
  const activeKey = getActiveOrderAccountKey();

  let text = `<b>My Swiggy Accounts</b>\n\nSelect an account:\n`;
  const buttons = [];

  for (const [key, acc] of Object.entries(accounts)) {
    const isActive = key === activeKey;
    const statusText = isActive ? 'Active' : (acc.isLoggedIn ? 'Saved' : 'Not Logged In');
    text += `${acc.name || key} <code>${acc.phone || ''}</code> ${statusText}\n`;

    buttons.push([
      {
        text: `${isActive ? '[Active] ' : ''}${acc.name || key} (${acc.phone || 'No phone'}) - ${statusText}`,
        callback_data: `acc_view_detail_${key}`,
        style: isActive ? 'success' : (acc.isLoggedIn ? 'primary' : 'danger')
      }
    ]);
  }

  buttons.push([
    { text: 'Add New Account', callback_data: 'boss_add_new_account_menu', style: 'primary' },
    { text: 'Refresh Accounts', callback_data: 'acc_refresh_list', style: 'primary' }
  ]);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      return;
    } catch (e) {
      if (e.message && e.message.includes('Message is not modified')) {
        return;
      }
    }
  }
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

bot.command('accounts', async (ctx) => handleMyAccounts(ctx));
bot.action('acc_refresh_list', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  await handleMyAccounts(ctx);
});

// Account Details screen (Full Unified Account Control Panel)
bot.action(/^acc_view_detail_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.reply('Account not found.');

  const activeKey = getActiveOrderAccountKey();
  const isActive = key === activeKey;
  const isLogged = isAccountLoggedInSession(acc);

  const phone = acc.phone || acc.mobile || '';
  // The portable 7-key JSON ({name, customerId, mobile, token, tid, sid, deviceId})
  // — exactly the shape the Boss pastes elsewhere.
  const compactStr = portableSessionJsonText(acc, key, { pretty: false });

  const detail = accountDetailText({ acc, key, activeKey: isActive ? key : '' });

  const text = `<b>Swiggy Account Control</b>\n\n` +
    detail.text +
    (isActive ? `\n★ <b>(Currently Active Order Hub)</b>` : '') +
    (acc.sessionExpired ? `\n⚠️ <i>Swiggy session has expired. Please re-login via OTP or drop a fresh JSON below to use this account for orders!</i>` : '') +
    `\n\nSelect an option:`;

  const buttons = [];

  if (isLogged) {
    buttons.push([
      { text: '⟳ Live Check Orders', callback_data: `acc_live_orders_${key}`, style: 'primary' },
      { text: '▣ Claim ₹50 Offers', callback_data: `boss_retry_claim_${key}`, style: 'success' },
    ]);
    // 🎁 OFFER DOCTOR — "dusre ID par night offer lag raha, mere par nahi" ka
    // seedha jawab: har campaign ki ASLI server state + one-tap fix.
    buttons.push([
      { text: '🎁 Night Offer Doctor', callback_data: `boss_offer_doctor_${key}`, style: 'primary' },
      { text: '🔧 Fix ₹50 ab', callback_data: `boss_offer_fix_${key}`, style: 'success' }
    ]);
    buttons.push([
      { text: '₹ Claim Free Cash', callback_data: `boss_check_fc_${key}`, style: 'success' }
    ]);
    buttons.push([
      { text: 'Set as Active Order Hub', callback_data: `acc_set_active_${key}`, style: 'success' },
      { text: 'Export JSON', callback_data: `boss_export_json_${key}`, style: 'primary' }
    ]);
    buttons.push([
      { text: 'Saved Addresses', callback_data: `acc_view_addrs_${key}`, style: 'primary' },
      { text: 'Previous Orders', callback_data: `acc_view_orders_${key}`, style: 'primary' }
    ]);
    buttons.push([
      { text: 'View Cart', callback_data: `acc_view_cart_${key}`, style: 'primary' },
      { text: '↗ Logout Account', callback_data: `boss_logout_single_${key}`, style: 'danger' }
    ]);
    buttons.push([
      { text: 'Delete Account from Swiggy', callback_data: `boss_swiggy_delete_start_${key}`, style: 'danger' },
      { text: '× Remove from Bot', callback_data: `boss_remove_local_${key}`, style: 'danger' }
    ]);
  } else {
    buttons.push([
      { text: `◈ Re-Login ${phone || 'OTP'}`, callback_data: `boss_login_acc_otp_${key}`, style: 'success' },
      { text: '▤ Re-Login with Code', callback_data: `boss_login_acc_json_${key}`, style: 'primary' }
    ]);
    buttons.push([
      { text: 'Previous Orders', callback_data: `acc_view_orders_${key}`, style: 'primary' },
      { text: '↗ Logout & Remove', callback_data: `boss_logout_single_${key}`, style: 'danger' }
    ]);
    buttons.push([
      { text: '× Remove from Bot DB', callback_data: `boss_remove_local_${key}`, style: 'danger' }
    ]);
  }

  // ⬇ COPY BLOCK — always at the BOTTOM, one per account.
  //   • "Copy Session JSON" -> native one-tap copy when it fits, else chunks
  //   • "Send .json"        -> real file for long sessions
  const copyRow = [];
  if (compactStr) {
    copyRow.push(makeFullSessionCopyButton(ctx, '▤ Copy Session JSON', key, compactStr, `acc_copy_json_${key}`, 'success'));
    copyRow.push({ text: '⬇ Send .json', callback_data: `acc_send_json_${key}`, style: 'primary' });
  }
  if (phone) {
    copyRow.push({ text: '☎ Copy Number', copy_text: { text: phone }, style: 'primary' });
  }
  if (copyRow.length) buttons.push(copyRow);

  buttons.push([
    { text: 'Back to Accounts', callback_data: 'boss_view_accounts', style: 'primary' },
    { text: 'Main Menu', callback_data: 'boss_panel_home', style: 'primary' }
  ]);

  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    if (e.message && e.message.includes('Message is not modified')) return;
    await sendSafeHtml(ctx, text, { reply_markup: { inline_keyboard: buttons } });
  }
});

// ⟳ LIVE ORDER CHECK — the ONLY way an order count is ever displayed.
bot.action(/^acc_live_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Swiggy se live check kar raha hoon…').catch(() => {});
  let note = '';
  try {
    const prof = await inspectAccountOrderHistoryAndOffers(key, acc, { force: true });
    const target = getDb().config?.accounts?.[key] || acc;
    if (prof && prof.valid !== false && prof.ordersVerifiedLive === true && typeof prof.totalOrdersCount === 'number') {
      target.totalOrdersCount = prof.totalOrdersCount;
      target.cachedTotalOrdersCount = prof.totalOrdersCount;
      target.ordersVerifiedLive = true;
      target.orderCountSource = 'LIVE';
      target.orderTruthCheckedAt = new Date().toISOString();
      target.isZeroOrderAccount = prof.totalOrdersCount === 0;
      target.liveActiveOrdersCount = Number(prof.liveActiveOrdersCount || 0);
      delete target.accountError;
      saveDb(getDb());
      note = prof.totalOrdersCount === 0
        ? '★ LIVE check: is ID par <b>0 orders</b> (Swiggy ne khud bataya).'
        : `● LIVE check: <b>${prof.totalOrdersCount} order(s)</b> mile Swiggy par.`;
    } else {
      target.ordersVerifiedLive = false;
      target.orderCountSource = 'UNVERIFIED';
      delete target.totalOrdersCount;
      delete target.isZeroOrderAccount;
      target.accountError = prof?.error || 'Live check nahi chala';
      saveDb(getDb());
      note = `⚠️ Live check fail: <b>${escapeHtml(String(prof?.error || 'Swiggy se jawab nahi aaya'))}</b>\n<i>File me likha order count nahi maana jayega.</i>`;
    }
  } catch (e) {
    note = `⚠️ Live check error: <b>${escapeHtml(String(e.message || e))}</b>`;
  }
  const fresh = getDb().config?.accounts?.[key] || acc;
  const detail = accountDetailText({ acc: fresh, key, activeKey: getActiveOrderAccountKey() === key ? key : '' });
  return sendSafeHtml(ctx, `${note}\n\n${detail.text}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⟳ Check Again', callback_data: `acc_live_orders_${key}`, style: 'primary' }],
        [{ text: '← Back to Account', callback_data: `acc_view_detail_${key}`, style: 'primary' }]
      ]
    }
  });
});

// ▤ Copy Session JSON — the exact 7 fields: name, customerId, mobile, token, tid, sid, deviceId
bot.action(/^acc_copy_json_(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const acc = getDb().config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  const pretty = portableSessionJsonText(acc, key, { pretty: true });
  const compact = portableSessionJsonText(acc, key, { pretty: false });
  await ctx.answerCbQuery('Neeche code tap karke copy karein ▤').catch(() => {});
  // Telegram copy_text caps at 256 chars, so a long session is split into
  // tappable chunks (each is a real, copyable piece) — plus the .json file.
  const chunks = [];
  let rest = compact;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 250));
    rest = rest.slice(250);
  }
  const body = chunks.map((c, i) => `<b>${i + 1}/${chunks.length}</b> <code>${escapeHtml(c)}</code>`).join('\n');
  await sendSafeHtml(ctx,
    `▤ <b>Session JSON</b> — <code>${escapeHtml(String(acc.phone || key))}</code>\n` +
    `<i>Har chunk tap karke copy karein (Telegram limit 256 chars).</i>\n\n${body}\n\n` +
    `<pre><code class="language-json">${escapeHtml(pretty)}</code></pre>`,
    { reply_markup: { inline_keyboard: [[{ text: '⬇ Send as .json file', callback_data: `acc_send_json_${key}`, style: 'primary' }]] } }
  ).catch(async () => {
    await ctx.reply(pretty);
  });
});

// ⬇ Send EVERY account's portable JSON (one .json document each)
bot.action('boss_send_all_json', async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Bhej raha hoon…').catch(() => {});
  const accounts = Object.entries(getDb().config?.accounts || {});
  if (accounts.length === 0) return ctx.reply('Koi account saved nahi hai.');
  let sent = 0;
  for (const [key, acc] of accounts.slice(0, 40)) {
    if (!acc) continue;
    const payload = buildPortableSessionJson(acc, key);
    const phone = String(acc.phone || key).replace(/\D/g, '').slice(-10) || 'session';
    try {
      await ctx.replyWithDocument(
        { source: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), filename: `${phone}.json` },
        { caption: `▤ <b>${escapeHtml(String(acc.name || phone))}</b> · <code>${phone}</code>`, parse_mode: 'HTML' }
      );
      sent++;
    } catch { /* continue */ }
  }
  await ctx.reply(`✓ ${sent}/${accounts.length} account JSON bheje gaye.`).catch(() => {});
});

// ⬇ Send the portable session as a real .json document
bot.action(/^acc_send_json_(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const acc = getDb().config?.accounts?.[key];
  if (!acc) return ctx.answerCbQuery('Account not found', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const json = buildPortableSessionJson(acc, key);
  const phone = String(acc.phone || key).replace(/\D/g, '').slice(-10) || 'session';
  await ctx.replyWithDocument(
    { source: Buffer.from(JSON.stringify(json, null, 2), 'utf8'), filename: `${phone}.json` },
    { caption: `▤ <b>${escapeHtml(String(acc.name || phone))}</b> · <code>${phone}</code>\n<i>7 fields: name, customerId, mobile, token, tid, sid, deviceId</i>`, parse_mode: 'HTML' }
  ).catch((e) => ctx.reply(`Send failed: ${e.message}`).catch(() => {}));
});

// Set as Active Order Hub
bot.action(/^acc_set_active_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  setActiveOrderAccountKey(key);
  await ctx.answerCbQuery('Order Hub ready! !').catch(() => {});
  await ctx.reply(`<b>Order Hub ready — orders will now be placed from this account.</b>`, { parse_mode: 'HTML' });
});

// Permanent Logout
bot.action(/^acc_perm_logout_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  const key = ctx.match[1];
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  const name = acc?.name || key;
  const phone = acc?.phone || '';

  permanentLogoutAccount(key, { purgeVault: true });
  deleteAccount(key, { purgeVault: true });
  await ctx.answerCbQuery('Permanent Logout Successful ↗').catch(() => {});
  await ctx.reply(
    `<b>Permanent Logout Successful</b>\n\n` +
    `<b>${escapeHtml(name)}</b> <code>${escapeHtml(phone)}</code>\n\n` +
    `The account has been removed from My Swiggy Accounts. To use it again, add it via Login.`,
    { parse_mode: 'HTML' }
  );
});

// 3. Previous Orders
async function handlePreviousOrders(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(`! <b>${escapeHtml(acc?.name || activeKey)} is not logged in!</b>\nPlease login to view previous orders.`, { parse_mode: 'HTML' });
  }

  const orders = await fetchAccountOrders(acc);
  if (Array.isArray(orders)) {
    acc.totalOrdersCount = orders.length;
    acc.cachedTotalOrdersCount = orders.length;
    acc.isZeroOrderAccount = (orders.length === 0);
    saveDb(db);
  }

  if (!orders || orders.length === 0) {
    const emptyText = 
      `<blockquote>▣ <b>PREVIOUS ORDERS</b></blockquote>\n\n` +
      `☎ <b>Account:</b> <code>${acc.phone || ''}</code> (<b>${escapeHtml(acc.name || activeKey)}</b>)\n` +
      `# <b>Customer ID:</b> <code>${acc.customerId || 'Verified'}</code>\n\n` +
      `<i>Is account se Swiggy par abhi tak koi previous order nahi mila (0 orders).</i>`;
    return sendSafeHtml(ctx, emptyText, Markup.inlineKeyboard([
      [
        Markup.button.callback('Delete Account from Swiggy', `boss_swiggy_delete_start_${activeKey}`),
        Markup.button.callback('Refresh Orders', `acc_view_orders_${activeKey}`)
      ],
      [
        Markup.button.callback('Add Another Account', 'send_to_another_number'),
        Markup.button.callback('Main Menu', 'boss_panel_home')
      ]
    ]));
  }

  let text = 
    `<blockquote>▣ <b>PREVIOUS ORDERS (${orders.length})</b></blockquote>\n\n` +
    `☎ <b>Account:</b> <code>${acc.phone || ''}</code> (<b>${escapeHtml(acc.name || activeKey)}</b>)\n` +
    `# <b>Customer ID:</b> <code>${acc.customerId || 'Verified'}</code>\n\n`;

  const buttons = [];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const prevRawLink = o.trackingUrl ? String(o.trackingUrl).trim() : '';
    const validPrevTrack = prevRawLink &&
      isOfficialSwiggyTrackingUrl(prevRawLink, { allowProviderShortLink: true }) &&
      !isFabricatedTrackingUrl(prevRawLink, String(o.orderId || ''))
      ? prevRawLink
      : '';
    const prevStatus = normalizeSwiggyLiveOrderStatus(o.status) || o.status || 'Completed';
    const isPrevDelivered = !/cancel|refus|return/i.test(String(prevStatus)) && /deliv|complet/i.test(String(prevStatus));
    const prevDeliveredUrl = !validPrevTrack && isPrevDelivered && o.orderId
      ? (o.deliveredTrackUrl || buildSignedOrderTrackUrl(o.orderId))
      : '';
    const resolvedPrevLink = validPrevTrack || prevDeliveredUrl;
    const statusIcon = String(prevStatus).toLowerCase().includes('deliv') ? '●' : '●';
    text += `<b>${i + 1}. ${escapeHtml(o.restaurantName || 'Swiggy Food')}</b>\n` +
      `• # <b>Order ID:</b> <code>#${o.orderId}</code>\n` +
      `• ₹ <b>Amount:</b> <b>₹${o.orderTotal || 0}</b> • ${statusIcon} <code>${escapeHtml(prevStatus)}</code>\n` +
      (o.items && o.items.length > 0 ? `• ▤ <i>${escapeHtml(o.items.join(', '))}</i>\n` : '') +
      (o.deliveryAddress ? `• ⌖ <code>${escapeHtml(o.deliveryAddress)}</code>\n` : '') +
      (o.deliveryOtp ? `• ⌕ <b>Delivery OTP:</b> <code>${escapeHtml(String(o.deliveryOtp))}</code>\n` : '') +
      (resolvedPrevLink ? `• 🔗 <b>Tracking:</b> <a href="${escapeHtml(resolvedPrevLink)}">${validPrevTrack ? 'Open Swiggy tracking' : 'Open order tracking'}</a>\n` : '') +
      (o.orderTime ? `• ◷ <i>${escapeHtml(o.orderTime)}</i>\n` : '') +
      `\n`;

    if (resolvedPrevLink && buttons.length < 20) {
      buttons.push([
        Markup.button.url(`↗ Track #${o.orderId} (${truncateDisplayField(o.restaurantName || 'Order', 18)})`, resolvedPrevLink)
      ]);
    } else if (o.orderId && !/cancel/i.test(String(prevStatus)) && buttons.length < 20) {
      buttons.push([
        Markup.button.callback(`🔗 Extract Tracking #${String(o.orderId).slice(-6)}`, `extract_now_${o.orderId}`)
      ]);
    }
  }

  buttons.push([
    Markup.button.callback('Delete Account from Swiggy', `boss_swiggy_delete_start_${activeKey}`),
    Markup.button.callback('Refresh Orders', `acc_view_orders_${activeKey}`)
  ]);
  buttons.push([
    Markup.button.callback('Add Another Account', 'send_to_another_number'),
    Markup.button.callback('Main Menu', 'boss_panel_home')
  ]);

  await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
}

bot.hears(['▣ Previous Orders', '▣ My Orders', 'Previous Orders', 'previous orders'], async (ctx) => handlePreviousOrders(ctx));
bot.command(['orders', 'previous_orders'], async (ctx) => handlePreviousOrders(ctx));
bot.action(/^acc_view_orders_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handlePreviousOrders(ctx, key);
});

// ================= ORDERS DONE (ALL IDs) =================
async function handleAllOrdersDone(ctx) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('Fetching live orders from your logged-in ID...').catch(() => {});
  }

  let statusMsg = null;
  try {
    statusMsg = await ctx.reply('⏳ <i>Logged-in accounts se live orders aur tracking links fetch ho rahe hain...</i>', { parse_mode: 'HTML' });
  } catch (e) {}

  try {
    const db = getDb();
    const accounts = db.config?.accounts || {};
    const accountEntries = Object.entries(accounts);

    if (accountEntries.length === 0) {
      if (statusMsg) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
      }
      return ctx.reply('⚠️ <b>Koi bhi Swiggy account added nahi hai!</b>\n\nBoss panel se pehle number ya JSON ke zariye account login karein.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')],
          [Markup.button.callback('▤ Login with JSON', 'boss_login_with_json')],
          [Markup.button.callback('★ Boss Panel', 'boss_panel_home')]
        ])
      });
    }

    const activeKey = getActiveOrderAccountKey(db);

    // Sort accounts so active logged-in account is first, followed by other logged-in accounts
    accountEntries.sort(([k1, a1], [k2, a2]) => {
      if (k1 === activeKey) return -1;
      if (k2 === activeKey) return 1;
      const logged1 = Boolean(a1 && (a1.isLoggedIn || a1.cookies || a1.tid));
      const logged2 = Boolean(a2 && (a2.isLoggedIn || a2.cookies || a2.tid));
      if (logged1 && !logged2) return -1;
      if (!logged1 && logged2) return 1;
      return 0;
    });

    const loggedInEntries = accountEntries.filter(([, a]) => a && (a.isLoggedIn || a.cookies || a.tid));
    const notLoggedInCount = accountEntries.length - loggedInEntries.length;

    if (loggedInEntries.length === 0) {
      if (statusMsg) {
        try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
      }
      return ctx.reply('⚠️ <b>Koi bhi logged-in Swiggy account nahi mila!</b>\n\nLive orders aur tracking links dekhne ke liye pehle number ya JSON se account login karein.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('☎ Login with Number', 'boss_login_with_number')],
          [Markup.button.callback('▤ Login with JSON', 'boss_login_with_json')],
          [Markup.button.callback('★ Boss Panel', 'boss_panel_home')]
        ])
      });
    }

    // Fetch live orders from all logged-in accounts (with warm WAF token & rate-safe budget).
    // Each account is capped so a slow Swiggy ID can never stall the whole
    // dashboard (this used to end in a 240s handler timeout).
    await getCachedWafToken(false).catch(() => {});
    const fetchWithBudget = (acc, ms) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), ms);
      timer.unref?.();
      Promise.resolve()
        .then(() => fetchAccountOrders(acc))
        .then(orders => resolve(Array.isArray(orders) ? orders : []))
        .catch(() => resolve([]))
        .finally(() => clearTimeout(timer));
    });
    const accountResults = [];
    for (const [key, acc] of loggedInEntries) {
      try {
        const orders = await fetchWithBudget(acc, 25000);
        accountResults.push({
          status: 'fulfilled',
          value: { key, acc, orders: Array.isArray(orders) ? orders : [], isActive: key === activeKey }
        });
      } catch (err) {
        console.error(`[ORDERS_DONE] Error fetching orders for ${acc?.name || key}:`, err?.message || err);
        accountResults.push({
          status: 'fulfilled',
          value: { key, acc, orders: [], isActive: key === activeKey, error: err?.message }
        });
      }
      if (loggedInEntries.length > 1) {
        await new Promise(r => setTimeout(r, 80));
      }
    }

    // Also collect completed orders recorded in db.orders
    const dbOrders = Object.values(db.orders || {});
    const dbCompletedOrders = dbOrders.filter(o =>
      o.status === 'COMPLETED' || o.swiggyOrderId || (o.trackingLink && isOfficialSwiggyTrackingUrl(o.trackingLink))
    );

    let totalOrdersFound = 0;
    const buttons = [];
    const emptyAccounts = [];
    const matchedDbOrderIds = new Set();
    let text = `<blockquote>📦 <b>ORDERS DONE — LOGGED IN SWIGGY IDs</b></blockquote>\n\n`;

    for (const res of accountResults) {
      if (res.status !== 'fulfilled') continue;
      const { key, acc, orders, isActive } = res.value;
      const accName = acc.name || key;
      const phoneStr = acc.phone ? `<code>${acc.phone}</code>` : '';
      const badge = isActive ? '🟢 <b>Active Logged-in ID:</b>' : '📱 <b>Logged-in ID:</b>';

      // Augment orders with any db.orders matching by Swiggy order id OR placing account
      for (const dbo of Object.values(db.orders || {})) {
        if (!dbo || typeof dbo !== 'object') continue;
        const swiggyId = String(dbo.swiggyOrderId || dbo.pendingSwiggyOrderId || dbo.id || '');
        const existingById = swiggyId ? orders.find(o => String(o.orderId || '') === swiggyId) : null;
        if (existingById) {
          matchedDbOrderIds.add(String(dbo.id || dbo.swiggyOrderId));
          const storedTrack = getStoredSwiggyTrackingUrl(dbo);
          if (!existingById.trackingUrl && storedTrack) {
            existingById.trackingUrl = storedTrack;
          }
          if (!existingById.deliveryOtp && dbo.deliveryOtp) {
            existingById.deliveryOtp = dbo.deliveryOtp;
          }
          continue;
        }
        const matchesAccount = (dbo.selectedAccount && dbo.selectedAccount === key) ||
          (dbo.selectedAccountPhone && acc.phone && dbo.selectedAccountPhone === acc.phone) ||
          (dbo.orderAccount && acc.phone && String(dbo.orderAccount).includes(acc.phone));
        if (matchesAccount && dbo.status === 'COMPLETED') {
          matchedDbOrderIds.add(String(dbo.id || dbo.swiggyOrderId));
          // Never synthesize a tracking URL — only real Swiggy links are shown
          const realTrack = getStoredSwiggyTrackingUrl(dbo);
          orders.unshift({
            orderId: dbo.swiggyOrderId || '',
            orderRef: String(dbo.id || ''),
            restaurantName: dbo.restaurantName || 'Swiggy Food',
            status: dbo.liveOrderStatus || dbo.status || 'COMPLETED',
            items: (dbo.items || []).map(i => `${i.name}${i.qty > 1 ? ` (${i.qty})` : ''}`),
            deliveryAddress: dbo.addressDetails?.address || dbo.address || '',
            orderTotal: dbo.finalPayable || 0,
            trackingUrl: realTrack,
            deliveryOtp: dbo.deliveryOtp || '',
            placedFrom: String(dbo.selectedAccountPhone || dbo.orderAccount || acc.phone || ''),
            orderTime: dbo.completedAt ? new Date(dbo.completedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''
          });
        }
      }

      if (!orders || orders.length === 0) {
        // collect empty accounts, don't spam per-account — summary after loop
        emptyAccounts.push({ name: accName, phone: acc.phone || '' });
        continue;
      }

      const cleanHeaderName = acc.phone
        ? String(accName).replace(new RegExp(`\\s*\\(\\s*${String(acc.phone).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)\\s*$`), '').trim() || accName
        : accName;
      text += `📱 <b>${escapeHtml(cleanHeaderName)}</b> ${phoneStr ? `(Placed from ${phoneStr})` : ''}\n`;
      totalOrdersFound += orders.length;
      text += `<i>Total Orders: <b>${orders.length}</b></i>\n\n`;

      for (let i = 0; i < orders.length; i++) {
        const o = orders[i];
        const rowSwiggyId = /^\d{10,20}$/.test(String(o.orderId || '')) ? String(o.orderId) : '';
        const rawTrackLink2 = o.trackingUrl ? String(o.trackingUrl).trim() : '';
        const validTrackUrl = rawTrackLink2 &&
          isOfficialSwiggyTrackingUrl(rawTrackLink2, { allowProviderShortLink: true }) &&
          !isFabricatedTrackingUrl(rawTrackLink2, rowSwiggyId)
          ? rawTrackLink2
          : '';
        const normalizedStatus = normalizeSwiggyLiveOrderStatus(o.status) || o.status || 'COMPLETED';
        const statusRaw = String(normalizedStatus);
        const isRowDelivered = !/cancel|refus|return/i.test(statusRaw) && /deliv|complet/i.test(statusRaw);
        const rowDeliveredUrl = !validTrackUrl && isRowDelivered && (rowSwiggyId || o.orderRef)
          ? (o.deliveredTrackUrl || buildSignedOrderTrackUrl(rowSwiggyId || o.orderRef))
          : '';
        const trackingDisplay = trackingLinkDisplay({
          url: validTrackUrl,
          fallbackTrackUrl: rowDeliveredUrl,
          status: statusRaw,
          orderId: rowSwiggyId
        });
        const statusStr = escapeHtml(statusRaw);
        const restName = escapeHtml(o.restaurantName || 'Swiggy Food');
        const rowRef = String(o.orderRef || (rowSwiggyId ? '' : (o.orderId || '')));
        const rowPhone = String(o.placedFrom || acc.phone || '');

        text += `<b>${i + 1}. ${restName}</b>\n` +
          (rowSwiggyId ? `• 🆔 <b>Swiggy order:</b> <code>${escapeHtml(rowSwiggyId)}</code>\n` : `• 🆔 <b>Swiggy order:</b> <i>not created yet</i>\n`) +
          (rowRef ? `• 🧾 <b>Order ref:</b> <code>#${escapeHtml(rowRef)}</code>\n` : '') +
          `• ☎ <b>Placed from:</b> <code>${escapeHtml(rowPhone || 'unknown')}</code>\n` +
          `• 💰 <b>Total:</b> <b>₹${o.orderTotal || 0}</b> · <b>Status:</b> <code>${statusStr}</code>\n` +
          (o.items && o.items.length ? `• 🍽️ <b>Items:</b> <i>${escapeHtml(o.items.join(', '))}</i>\n` : '') +
          (o.deliveryAddress ? `• 📍 <b>Address:</b> <code>${escapeHtml(o.deliveryAddress)}</code>\n` : '') +
          (o.deliveryOtp ? `• 🔢 <b>Delivery OTP:</b> <code>${escapeHtml(String(o.deliveryOtp))}</code>\n` : '') +
          (o.orderTime ? `• 🕒 <b>Time:</b> <i>${escapeHtml(String(o.orderTime))}</i>\n` : '') +
          `• 🔗 <b>Tracking Link:</b> ${trackingDisplay}\n\n`;

        const resolvedRowButtonUrl = validTrackUrl || rowDeliveredUrl;
        if (resolvedRowButtonUrl && buttons.length < 25) {
          buttons.push([
            Markup.button.url(`↗ Track #${rowSwiggyId || rowRef || 'order'} (${truncateDisplayField(o.restaurantName || 'Order', 18)})`, resolvedRowButtonUrl)
          ]);
        } else if (!resolvedRowButtonUrl && rowSwiggyId && !/cancel/i.test(statusRaw) && buttons.length < 25) {
          buttons.push([
            Markup.button.callback(`🔗 Extract Link #${rowSwiggyId.slice(-6)} (${truncateDisplayField(o.restaurantName || 'Order', 16)})`, `extract_now_${rowSwiggyId}`)
          ]);
        }
      }
    }

    if (notLoggedInCount > 0) {
      text += `━━━━━━━━━━━━━━━━━━━━\n<i>⚠️ ${notLoggedInCount} other account(s) login required.</i>\n\n`;
    }

    // Summary for empty accounts instead of spamming per-account 0-orders blocks
    if (emptyAccounts.length > 0) {
      const formatEmptyAccount = (a) => {
        const namePart = String(a.name || '').trim();
        const phonePart = String(a.phone || '').trim();
        if (phonePart && namePart && !namePart.includes(phonePart)) {
          return `${escapeHtml(namePart)} (${escapeHtml(phonePart)})`;
        }
        return escapeHtml(namePart || phonePart || 'Account');
      };
      const emptyList = emptyAccounts.map(formatEmptyAccount).join(', ');
      if (totalOrdersFound > 0) {
        text += `━━━━━━━━━━━━━━━━━━━━\n<i>ℹ️ ${emptyAccounts.length} ID(s) me koi orders nahi mile: ${emptyList}</i>\n\n`;
      } else {
        text += `━━━━━━━━━━━━━━━━━━━━\n<i>ℹ️ ${emptyAccounts.length} ID(s) me koi orders nahi mile: ${emptyList}</i>\n`;
      }
    }

    // Show unmatched bot orders that didn't associate to any logged-in ID (so user never sees contradictory 0-orders)
    const unmatchedBotOrders = dbCompletedOrders.filter(dbo => !matchedDbOrderIds.has(String(dbo.id || dbo.swiggyOrderId)));
    if (unmatchedBotOrders.length > 0) {
      text += `📦 <b>Bot-tracked orders (account not logged in)</b>\n\n`;
      for (let i = 0; i < unmatchedBotOrders.length; i++) {
        const dbo = unmatchedBotOrders[i];
        const validTrackUrl = getStoredSwiggyTrackingUrl(dbo);
        const swiggyId = swiggyOrderIdOf(dbo);
        const normalizedUnmatchedStatus = normalizeSwiggyLiveOrderStatus(dbo.liveOrderStatus) || dbo.liveOrderStatus || dbo.status || 'COMPLETED';
        const statusRaw = String(normalizedUnmatchedStatus);
        const isUnmatchedDelivered = !/cancel|refus|return/i.test(statusRaw) && /deliv|complet/i.test(statusRaw);
        const unmatchedDeliveredUrl = !validTrackUrl && isUnmatchedDelivered && (swiggyId || dbo.id)
          ? buildSignedOrderTrackUrl(swiggyId || dbo.id)
          : '';
        const trackingDisplay = trackingLinkDisplay({
          url: validTrackUrl,
          fallbackTrackUrl: unmatchedDeliveredUrl,
          status: statusRaw,
          orderId: swiggyId
        });
        const placedFrom = placedFromPhoneOf(dbo, db);
        text += `<b>${i + 1}. ${escapeHtml(dbo.restaurantName || 'Swiggy Food')}</b>\n` +
          `• 🆔 <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || 'not created yet')}</code>\n` +
          `• 🧾 <b>Order ref:</b> <code>#${escapeHtml(String(dbo.id))}</code>\n` +
          `• ☎ <b>Placed from:</b> <code>${escapeHtml(placedFrom || 'account not selected')}</code>\n` +
          `• 💰 <b>Total:</b> <b>₹${dbo.finalPayable || 0}</b> · <b>Status:</b> <code>${escapeHtml(statusRaw)}</code>\n` +
          (dbo.items && dbo.items.length ? `• 🍽️ <b>Items:</b> <i>${escapeHtml(dbo.items.map(it => it.name).join(', '))}</i>\n` : '') +
          (dbo.addressDetails?.address || dbo.address ? `• 📍 <b>Address:</b> <code>${escapeHtml(dbo.addressDetails?.address || dbo.address)}</code>\n` : '') +
          (dbo.deliveryOtp ? `• 🔢 <b>Delivery OTP:</b> <code>${escapeHtml(String(dbo.deliveryOtp))}</code>\n` : '') +
          (dbo.completedAt ? `• 🕒 <b>Time:</b> <i>${escapeHtml(new Date(dbo.completedAt).toLocaleString('en-IN'))}</i>\n` : '') +
          `• 🔗 <b>Tracking Link:</b> ${trackingDisplay}\n\n`;
        totalOrdersFound += 1;
        const resolvedUnmatchedUrl = validTrackUrl || unmatchedDeliveredUrl;
        if (resolvedUnmatchedUrl && buttons.length < 25) {
          buttons.push([Markup.button.url(`↗ Track #${swiggyId || dbo.id} (${truncateDisplayField(dbo.restaurantName || 'Order', 18)})`, resolvedUnmatchedUrl)]);
        }
      }
    }

    if (totalOrdersFound === 0) {
      text += `\n<i>Connected accounts me abhi koi completed orders nahi hain.</i>`;
    }

    buttons.push([
      Markup.button.callback('↻ Refresh Orders Done', 'boss_view_orders_done'),
      Markup.button.callback('★ Boss Panel', 'boss_panel_home')
    ]);

    if (statusMsg) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    }

    await sendSafeHtml(ctx, text.trim(), Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('[ORDERS_DONE] Execution error:', err?.stack || err?.message || err);
    if (statusMsg) {
      try { await bot.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}
    }
    await ctx.reply(`❌ <b>Orders Done fetch karne me error aaya:</b> ${escapeHtml(err?.message || 'Unknown error')}`, {
      parse_mode: 'HTML'
    });
  }
}

// ---------------------------------------------------------------------------
// ACTIVE ORDERS -> OFO TRACKING LINK (read-only sweep)
// ---------------------------------------------------------------------------
// Chases the share/track link of every RUNNING order using the live route:
//   order/trackV4 -> data.fyi_details[].value.cta_link ->
//   swiggy://share?text=<https://www.swiggy.com/ofo/track/...>
// Nothing here logs out, re-logs or "wipes" an ID: the scan runs read-only, so
// ongoing orders and every logged-in account stay exactly as they are.
async function runActiveOrdersTrackingSweep(ctx, { silent = false } = {}) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  const pending = listActiveOrdersNeedingTracking();
  if (pending.length === 0) {
    if (!silent) await ctx.reply('✓ <b>Saare active orders ke tracking links already saved hain.</b>', { parse_mode: 'HTML' }).catch(() => {});
    return { scanned: 0, found: 0, stillMissing: 0, results: [] };
  }
  const wait = silent
    ? null
    : await ctx.reply(
      `◷ <i>${pending.length} active order(s) ke Swiggy OFO link check kar raha hoon… (koi ID logout/remove nahi hogi)</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => null);

  const out = await refreshActiveOrdersTracking({ budgetMs: 15000, deep: true, concurrency: 6, limit: 12 });

  if (wait) { try { await bot.telegram.deleteMessage(chatId, wait.message_id); } catch {} }
  if (silent) return out;

  const lines = [
    `🔗 <b>Active orders — OFO link sweep</b>`,
    '',
    `▪ <b>Checked:</b> ${out.scanned}`,
    `▪ <b>Link mila:</b> ${out.found}`,
    `▪ <b>Abhi nahi mila:</b> ${out.stillMissing}`,
    `▪ <b>IDs touched:</b> 0 — <i>koi logout / remove / session wipe nahi hua</i>`
  ];
  for (const row of out.results.slice(0, 8)) {
    const short = row.url ? ` — <a href="${escapeHtml(row.url)}">open</a>` : '';
    lines.push(`• <code>${escapeHtml(String(row.swiggyOrderId || row.orderId))}</code> — ${escapeHtml(row.status)}${short}`);
  }
  if (out.stillMissing > 0) {
    lines.push('', '<i>Jo links nahi mile, unke orders Swiggy par abhi publish nahi hue. Auto-tracking background me chalta rahega — accounts ko chhua nahi jayega.</i>');
  }
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Dobara check', 'boss_active_tracking')]])
  }).catch(() => {});
  return out;
}

bot.action(['boss_active_tracking', 'user_active_tracking'], async (ctx) => {
  await ctx.answerCbQuery('Active orders check kar raha hoon… ◷').catch(() => {});
  await runActiveOrdersTrackingSweep(ctx);
});
bot.hears(['🔄 Active Orders Tracking', 'Active Orders Tracking', 'active orders tracking', '/active_tracking'], async (ctx) => {
  await runActiveOrdersTrackingSweep(ctx);
});

bot.hears(['📦 Orders Done', 'Orders Done', 'orders done', 'orders_done', '/orders_done', '/ordersdone'], async (ctx) => {
  await handleAllOrdersDone(ctx);
});
bot.command(['ordersdone', 'orders_done'], async (ctx) => {
  await handleAllOrdersDone(ctx);
});
bot.action(['boss_view_orders_done', 'user_orders_done'], async (ctx) => {
  await handleAllOrdersDone(ctx);
});

// 4. View Cart
async function handleViewCart(ctx, targetKey = null) {
  if (!isBoss(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
    return ctx.reply('Unauthorized: Boss only');
  }
  const db = getDb();
  const activeKey = targetKey || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[activeKey];

  if (!acc || (!acc.cookies && !acc.tid)) {
    return ctx.reply(`! <b>${escapeHtml(acc?.name || activeKey)} is not logged in!</b>\nPlease login with OTP or JSON first.`, { parse_mode: 'HTML' });
  }

  const waitMsg = await ctx.reply(`▤ <i>Inspecting live cart & calculating best offers for ${acc.name || activeKey}...</i>`, { parse_mode: 'HTML' });
  const liveCart = await inspectCartForAccount(acc);

  try { await bot.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch (e) {}

  if (!liveCart || (!liveCart.restaurantName && (!liveCart.items || liveCart.items.length === 0))) {
    return ctx.reply(
      `▤ <b>Your Cart is empty</b> in <b>${acc.name || activeKey}</b>'s Swiggy account.\n\n` +
      `Aap Swiggy app me jakar items cart me add kar sakte hain ya cart link yahan paste kar sakte hain!`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.url('◎ Open Swiggy Web', 'https://www.swiggy.com/')],
          [Markup.button.callback('i Add Food via Link Video', 'action_link_guide')]
        ])
      }
    );
  }

  const receipt = formatSwiggyWorldCartReceipt(liveCart, acc.phone || acc.name || activeKey);
  await ctx.reply(receipt, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.url('◎ Open Swiggy Checkout', 'https://www.swiggy.com/checkout')],
      [Markup.button.callback('↻ Refresh Cart', `acc_view_cart_${activeKey}`)]
    ])
  });
}

bot.hears('▤ View Cart', async (ctx) => {
  if (!isBoss(ctx.from.id)) {
    const draft = getDraft(ctx.from.id);
    const count = Array.isArray(draft?.cartDetails?.items) ? draft.cartDetails.items.length : 0;
    return renderUserCard(ctx, ctx.from.id, {
      notice: count > 0 ? `▤ Cart me ${count} item${count === 1 ? '' : 's'} hain` : '▤ Cart abhi khali hai'
    });
  }
  return handleViewCart(ctx);
});
bot.command('cart', async (ctx) => handleViewCart(ctx));
bot.action(/^acc_view_cart_(.+)$/, async (ctx) => {
  if (!isBoss(ctx.from.id)) return ctx.answerCbQuery('Unauthorized', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const key = ctx.match[1];
  await handleViewCart(ctx, key);
});

// 5. Add Food via Link Guide
function handleLinkGuide(ctx) {
  return ctx.reply(
    `<b>Add Food Items via Link</b>\n\n` +
    `Did you know you can add food items to your cart directly through a link?\n` +
    `Watch this quick video https://t.me/FireByWorld/370\n\n` +
    `<i>Note: You can log in with any Swiggy account in the app — both accounts don't need to be the same.</i>`,
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: false }
    }
  );
}

bot.hears('i Add Food via Link', handleLinkGuide);
bot.command('link_guide', handleLinkGuide);
bot.action('action_link_guide', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  handleLinkGuide(ctx);
});

// Slot system removed — orders are unlimited without slot gating.
bot.command(['slots', 'resetslots'], async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  return ctx.reply('✓ <b>Slot system hata diya gaya hai</b> — ab unlimited orders direct chalte hain.', { parse_mode: 'HTML' });
});

bot.catch(async (err, ctx) => {
  const description = String(err?.description || '');
  const message = String(err?.message || '');

  // Ignore harmless "not modified" edits and transient Telegram races
  const ignorePhrases = [
    'message is not modified',
    'query is too old',
    'MESSAGE_ID_INVALID',
    'message is too long',
    'message to be edited',
    'message can\'t be edited'
  ];
  if (ignorePhrases.some(p => (message || description).toLowerCase().includes(p.toLowerCase()))) return;

  const updateType = ctx?.updateType || 'unknown';
  const errMsg = message || description || String(err);
  console.error(`× Bot error [${updateType}]:`, errMsg);
  if (err?.stack) console.error(`  ↳ ${String(err.stack).split('\n').slice(1, 4).join('\n  ↳ ')}`);

  // Tell the person who triggered it something useful — but only for real code
  // faults. Transient Telegram/network failures must not spam the chat.
  const looksLikeCodeFault = /is not defined|is not a function|ReferenceError|TypeError|Cannot read|undefined \(reading/i.test(`${message} ${description}`);
  if (looksLikeCodeFault) {
    try {
      if (ctx?.chat?.id && typeof ctx.reply === 'function') {
        await ctx.reply(
          '! <b>Kuch technical issue aa gaya.</b>\n\nKripya dobara try karein ya /start dabayein. Aapka data safe hai.',
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    } catch (e) {}
  }

  // Report to Boss with the exact failing line so the bug can be fixed fast.
  try {
    const db = getDb();
    const bossIds = db?.config?.bossIds || [];
    const diagMsg = formatBossDiagnosticErrorMessage(err, {
      stage: `GLOBAL_BOT_CATCH_${updateType.toUpperCase()}`,
      senderName: ctx?.from?.first_name || '',
      isForwarded: Boolean(ctx?.message && extractForwardSenderInfo(ctx.message)),
      cartLink: ctx?.callbackQuery?.data || ctx?.message?.text || ''
    });
    for (const bossId of bossIds) {
      await bot.telegram.sendMessage(bossId, diagMsg, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (e) {}
});

// =========================================================================
// Telegram order-state, bill-approval, and payment actions
// =========================================================================

// Telegram callbacks for bill approval, payment status, and corrected delivery details.

function isOrderCustomer(order, userId) {
  const allowedIds = [order?.fwdSenderUserId, order?.userId]
    .filter(value => value !== null && value !== undefined && String(value).trim() !== '')
    .map(String);
  return allowedIds.includes(String(userId));
}

export async function sendApprovedOrderPaymentToUser(uidStr, order, { force = false } = {}) {
  const callerId = String(uidStr || '').trim();
  const callerIsBoss = callerId && isBoss(Number(callerId));
  if (callerId && !isOrderCustomer(order, callerId) && !callerIsBoss) return false;
  const targetUserId = callerId && isOrderCustomer(order, callerId)
    ? callerId
    : String(order?.fwdSenderUserId || order?.userId || '').trim();
  if (!targetUserId) return false;
  if (!force && order.customerPaymentMessageId) return true;

  let upiUri = String(order.pendingSwiggyUpiUri || order.realUpiIntentUri || '').trim();
  const paymentUrl = String(order.swiggyPaymentUrl || '').trim();
  const isGenericCheckoutPlaceholder = /^https?:\/\/(?:www\.)?swiggy\.com\/(?:checkout|payments)\/?$/i.test(paymentUrl);
  const specificPaymentUrl = isGenericCheckoutPlaceholder ? '' : paymentUrl;
  const amount = Number(order.finalPayable || order.finalTotal || 0);
  const restaurant = escapeHtml(order.restaurantName || 'Swiggy Order');

  // 🚫 Boss (30-10-2026): "mere UPI ko as QR payment for Swiggy order bhej
  // raha" — ye galat tha aur khatarnaq: paisa boss ke account me jata tha par
  // Swiggy ka order UNPAID reh jata tha (Swiggy auto-cancel kar deta hai).
  // Isliye order ka payment QR SIRF Swiggy ka hoga. Swiggy na de to saaf batao.
  let qrBlockedReason = '';
  if (!upiUri && !specificPaymentUrl) {
    qrBlockedReason = 'Swiggy ne is order ke liye payment QR / link nahi diya';
  }
  // Final gate for EVERY QR (Swiggy ka ho ya fallback): invalid QR kabhi nahi.
  if (upiUri) {
    const gate = validateUpiIntentForQr(upiUri, { amount });
    if (!gate.valid) {
      console.warn(`[PaymentQR] Blocked invalid QR for #${order.id}: ${gate.problems.join(' | ')}`);
      qrBlockedReason = gate.problems.join('; ');
      upiUri = '';
    }
  }

  // Simple chat mode keeps the payment bubble to the bare minimum: pay + "I have paid".
  const simplePayment = isSimpleChatEnabled() && !isBoss(Number(targetUserId));
  const rows = [];
  if (paymentUrl) {
    rows.push([Markup.button.url(simplePayment ? '💳 Pay on Swiggy' : 'Pay via Swiggy (UPI/Card)', paymentUrl)]);
  }
  rows.push([Markup.button.callback(
    simplePayment ? '✓ I have paid — get tracking' : 'Check payment status',
    `user_paid_status_${order.id}`
  )]);
  if (!simplePayment && (upiUri || paymentUrl)) {
    rows.push([Markup.button.callback('Resend payment QR', `user_resend_approved_qr_${order.id}`)]);
  }
  const keyboard = Markup.inlineKeyboard(rows);

  if (upiUri) {
    // Same branded, personalised QR the Boss cards use: orange header with the
    // customer's name, the exact amount and the order id baked into the image.
    let qrBuffer = null;
    try {
      qrBuffer = await generateNamedUpiQrPngBuffer({
        upiUri,
        senderName: order.fwdSenderName || order.userName || 'Customer',
        restaurantName: order.restaurantName || 'Swiggy',
        amount,
        orderId: order.id
      });
    } catch (qrErr) {
      console.warn(`[PaymentQR] Personalised QR failed for #${order.id}:`, qrErr?.message || qrErr);
    }
    if (!qrBuffer) {
      qrBuffer = await QRCode.toBuffer(upiUri, {
        type: 'png',
        width: 900,
        margin: 3,
        errorCorrectionLevel: 'M'
      });
    }
    const simpleCaption = simplePayment
      ? `💳 <b>Pay ₹${amount}</b> · ${restaurant}\n` +
        `<i>QR scan karein (ya Pay button). Payment ke baad oopar wala "I have paid" dabayein — tracking link yahin aayega.</i>`
      : '';
    const caption = safeTelegramCaption(
      simpleCaption ||
      `₹ <b>Payment QR · Order #${escapeHtml(order.id)}</b>\n` +
      `◉ <b>For:</b> ${escapeHtml(order.fwdSenderName || order.userName || 'Customer')}\n` +
      `▤ <b>Restaurant:</b> ${restaurant}\n` +
      `₹ <b>Exact amount:</b> ₹${amount}\n\n` +
      `<i>This QR is Swiggy's own checkout request. Checking status verifies payment with Swiggy; a button tap alone never marks it paid.</i>`,
      1000
    );
    const sent = await bot.telegram.sendPhoto(targetUserId, { source: qrBuffer }, {
      caption,
      parse_mode: 'HTML',
      ...keyboard
    });
    order.customerPaymentMessageId = sent?.message_id || null;
    order.customerPaymentSentAt = new Date().toISOString();
    order.paymentSentToUser = true;
    order.paymentQrKind = 'SWIGGY_PERSONALISED';
    const db = getDb();
    db.orders[order.id] = order;
    saveDb(db);
    return true;
  }

  if (paymentUrl) {
    const sent = await bot.telegram.sendMessage(
      targetUserId,
      (simplePayment
        ? `💳 <b>Pay ₹${amount}</b> · ${restaurant}\n\n`
        : `↗ <b>Official Swiggy payment link · Order #${escapeHtml(order.id)}</b>\n\n`) +
      `▤ <b>Restaurant:</b> ${restaurant}\n` +
      `₹ <b>Exact amount:</b> ₹${amount}\n\n` +
      `<a href=\"${escapeHtml(paymentUrl)}\">Open Swiggy payment</a>\n` +
      `<i>Use the status button only after paying. Payment is verified with Swiggy.</i>`,
      {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...keyboard
      }
    );
    order.customerPaymentMessageId = sent?.message_id || null;
    order.customerPaymentSentAt = new Date().toISOString();
    order.paymentSentToUser = true;
    const db = getDb();
    db.orders[order.id] = order;
    saveDb(db);
    return true;
  }

  // No Swiggy intent, no real payment link, and no valid UPI configured:
  // send an HONEST message instead of an unscannable "invalid" QR.
  await bot.telegram.sendMessage(
    targetUserId,
    `✓ <b>Bill approved for order #${escapeHtml(order.id)}.</b>\n\n` +
    (qrBlockedReason
      ? `⚠️ <b>QR abhi nahi bheja gaya:</b> ${escapeHtml(qrBlockedReason)}\n` +
        `<i>Fake/placeholder UPI ka QR bhejne se scan par &quot;invalid&quot; hi aata hai — isliye bot ne roka.</i>\n\n`
      : '') +
    `Swiggy has not returned a payment QR or official payment link yet. Do not pay using another QR or link; the official payment details will be sent here when available.`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  // Boss ko turant batao — warna customer ko invalid QR jaata rahega.
  try {
    const bossIds = getDb().config?.bossIds || [];
    if (qrBlockedReason) {
      for (const bossId of bossIds) {
        await bot.telegram.sendMessage(
          bossId,
          `⚠️ <b>Payment QR blocked — Order #${escapeHtml(order.id)}</b>\n` +
          `▪ <b>Reason:</b> ${escapeHtml(qrBlockedReason)}\n` +
          `▪ <b>Amount:</b> ₹${amount}\n\n` +
          `<i>Swiggy ne payment intent nahi diya aur bot ka UPI valid set nahi hai. Apna UPI set karein: <code>/setupi yourname@upi</code></i>`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '₹ Set Payment UPI', callback_data: 'boss_set_payment_upi', style: 'primary' }]] }
          }
        ).catch(() => {});
      }
    }
  } catch { /* boss notice is best-effort */ }
  return false;
}

// A double-tap (or a consent-triggered auto-approve racing the manual tap) must
// never create a SECOND Swiggy payment order for the same order id.
const billApprovalInFlight = new Set();

export async function approveUserOrderBillAction(uidStr, orderId) {
  const key = String(orderId || '');
  if (key && billApprovalInFlight.has(key)) {
    const pending = getDb().orders?.[key];
    return { ok: true, orderId, duplicateTap: true, message: pending?.customerPaymentMessageId
      ? 'Payment QR already sent — check the chat.'
      : 'Payment details are being prepared…' };
  }
  if (key) billApprovalInFlight.add(key);
  try {
    return await approveUserOrderBillActionInner(uidStr, orderId);
  } finally {
    if (key) billApprovalInFlight.delete(key);
  }
}

async function approveUserOrderBillActionInner(uidStr, orderId) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isOrderCustomer(order, uidStr) && !isBoss(Number(uidStr))) {
    return { ok: false, error: 'Unauthorized: this is not your order.' };
  }
  if (order.status === 'COMPLETED') {
    return { ok: false, error: 'This order is already paid. No second payment QR will be created.' };
  }
  if (!['APPROVAL_PENDING', 'PAYMENT_PENDING'].includes(order.status)) {
    return { ok: false, error: 'This bill is not awaiting approval.' };
  }

  if (!order.billApprovedByUser) {
    order.billApprovedByUser = true;
    order.billApprovedAt = new Date().toISOString();
  }
  injectAccountSessionIntoOrder(order);
  order.status = 'PAYMENT_PENDING';
  order.uxStage = 'SCREEN_04_PAYMENT_PENDING';
  saveDb(db);

  const bossTargetId = Number(process.env.BOSS_ID || db.bosses?.[0] || 6484999726);
  let qrGenerationError = '';
  let qrGenerationFailure = null;

  // The shared QR entry point reserves the order owner's fee before Swiggy.
  if (!order.pendingSwiggyUpiUri && !order.realUpiIntentUri && !order.swiggyPaymentUrl) {
    try {
      await executeRealQrGenerationForOrder({
        telegram: bot.telegram,
        chatId: bossTargetId,
        orderId: order.id,
        formatOrderBodyFn: formatUserOrderCardText
      });
    } catch (error) {
      qrGenerationFailure = error;
      qrGenerationError = String(error?.message || 'Swiggy payment details could not be prepared.').slice(0, 350);
      if (error?.code === 'WALLET_LOW_BALANCE') {
        const lowDb = getDb();
        const lowOrder = lowDb.orders?.[orderId] || order;
        lowOrder.status = 'APPROVAL_PENDING';
        lowOrder.cardStage = 'AWAITING_WALLET';
        lowDb.orders[orderId] = lowOrder;
        saveDb(lowDb);
        const owner = String(error.diag?.userId || lowOrder.fwdSenderUserId || lowOrder.userId || '');
        if (owner) await bot.telegram.sendMessage(owner, qrGenerationError, {
          ...Markup.inlineKeyboard([
            [{ text: '👛 Wallet', callback_data: 'wallet_home', style: 'success' }],
            [{ text: '🔄 Retry order', callback_data: `user_retry_qr_${orderId}` }]
          ])
        }).catch(() => {});
        return { ok: false, code: 'WALLET_LOW_BALANCE', orderId, error: qrGenerationError };
      }
      console.warn(`[BillApproval] Swiggy payment details are not ready for #${order.id}:`, error.message);
    }
  }

  let updated = getDb().orders?.[orderId] || order;
  let directPaymentData = Boolean(String(
    updated.pendingSwiggyUpiUri || updated.realUpiIntentUri || updated.swiggyPaymentUrl || ''
  ).trim());
  // 🚫 Boss (30-10-2026): boss ki UPI ko Swiggy order ka payment QR banake
  // bhejna band. Order ka paisa SIRF Swiggy ke QR/link se jata hai (warna order
  // unpaid reh jata hai aur Swiggy cancel kar deta hai). Swiggy na de to seedha
  // "QR ban nahi paya — dobara try".
  const fallbackReady = false;
  const hasPaymentData = directPaymentData;

  // ── 2) QR FAIL → sirf "QR ban nahi paya, try again" (fee ka zikr nahi) ───
  if (!hasPaymentData) {
    if (qrGenerationFailure?.diag?.placementAttempted === true || readSwiggyPlacement(`chat:${String(orderId)}`)) {
      updated.cardStage = 'PLACEMENT_UNKNOWN';
      updated.qrFailedReason = qrGenerationError || 'Swiggy placement ka result clear nahi hai';
      const uncertainDb = getDb();
      uncertainDb.orders[orderId] = updated;
      saveDb(uncertainDb);
      const owner = String(updated.fwdSenderUserId || updated.userId || '');
      if (owner) await bot.telegram.sendMessage(owner, 'Order Swiggy par ho sakta hai. Same account ke My Orders me check karein; dobara order na karein.').catch(() => {});
      return { ok: false, code: 'PLACEMENT_OUTCOME_UNKNOWN', orderId, error: 'Swiggy My Orders check karein; dobara order na karein.' };
    }
    updated.cardStage = 'QR_RETRY';
    updated.qrFailedAt = new Date().toISOString();
    updated.qrFailedReason = qrGenerationError || 'Swiggy ne is order ke liye payment QR nahi diya';
    const failDb = getDb();
    failDb.orders[orderId] = updated;
    saveDb(failDb);
    await sendQrGenerationFailedCard(updated, { reason: updated.qrFailedReason }).catch(() => {});
    return {
      ok: false,
      code: 'QR_GENERATION_FAILED',
      orderId,
      error: qrGenerationError || 'QR ban nahi paya — dobara try karein.'
    };
  }

  // ── 3) QR ready → HOLD (store) — bina fee ke customer ko nahi jayega ─────
  // 📦 OFO truth: QR bana matlab order place hua — par OFO hua ya nahi, yeh
  // response se pata chalta hai. Jhooth nahi: jo mila wahi boss ko.
  try {
    const proof = String(updated.ofoCart?.proof || 'NONE');
    const proofHinglish = {
      CART_READBACK: 'live cart ne OFO wapas dikhaya (pakka)',
      PUSH_ECHO: 'Swiggy ne response me OFO echo kiya',
      NONE: 'koi OFO saboot nahi',
      REVERTED: 'bill badhne se revert kiya'
    }[proof] || proof;
    const ofoLine = updated.ofoPlaced
      ? `✅ OFO (order for others) — ${proofHinglish}. Tracking link isi order se aayega`
      : `❌ OFO confirm nahi hua (${proofHinglish}) — ${updated.ofoWarning || updated.ofoCart?.reason || 'Swiggy ne OFO flag accept nahi kiya'} → tracking link nahi aayega`;
    for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
      await bot.telegram.sendMessage(
        bossId,
        `📦 <b>ORDER PLACE</b> · <code>#${escapeHtml(String(updated.pendingSwiggyOrderId || updated.id))}</code>\n${escapeHtml(ofoLine)}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch { /* alert optional, order flow important */ }

  holdOrderQr(updated, {
    upiUri: updated.pendingSwiggyUpiUri || updated.realUpiIntentUri || '',
    paymentUrl: updated.swiggyPaymentUrl || '',
    fallbackReady
  });
  updated.status = 'PAYMENT_PENDING';
  updated.billApprovedByUser = true;
  const holdDb = getDb();
  holdDb.orders[orderId] = updated;
  saveDb(holdDb);

  // New orders were charged before placement. For older pending orders, keep
  // existing Swiggy payment details usable rather than creating another order.
  // ── 5) Fee settle → held QR RELEASE (customer ko wahi QR jata hai) ───────
  updated = getDb().orders?.[orderId] || updated;
  releaseOrderQr(updated);
  const releaseDb = getDb();
  releaseDb.orders[orderId] = updated;
  saveDb(releaseDb);

  let sentPayment;
  try {
    sentPayment = await sendApprovedOrderPaymentToUser(uidStr, updated);
  } catch (error) {
    return {
      ok: false,
      error: `Bill approved, but Telegram could not deliver the existing Swiggy payment details: ${error.message}. Refresh the order screen and resend the same QR; no new order will be created.`
    };
  }
  // Refresh the single card so it shows the payment-ready state (no new bubble).
  await updateOrderCards(getDb().orders?.[orderId] || updated).catch(() => {});

  return {
    ok: true,
    orderId,
    message: sentPayment
      ? 'Bill approved — the payment QR was sent in Telegram.'
      : 'Bill approved — waiting for Swiggy to return an official payment QR or link.'
  };
}

async function rejectUserOrderBillAction(uidStr, orderId) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { ok: false, error: 'Order not found.' };
  if (!isOrderCustomer(order, uidStr) && !isBoss(Number(uidStr))) {
    return { ok: false, error: 'Unauthorized: this is not your order.' };
  }
  if (order.billApprovedByUser || order.pendingSwiggyOrderId) {
    return { ok: false, error: 'The bill has already been approved or sent to Swiggy and cannot be returned for edits.' };
  }
  if (order.status !== 'APPROVAL_PENDING') {
    return { ok: false, error: 'This bill is no longer awaiting review.' };
  }
  if (order.selectedAccount) {
    releaseSwiggyAccountReservation(order.selectedAccount, order.id);
  }
  order.status = 'CANCELLED';
  order.cancelledReason = 'USER_SOMETHING_IS_WRONG';
  saveDb(db);
  // 🔒 ID wapas vault me — deliver/cancel dono par lock chhutna chahiye.
  closeOrderAccountLock(order.id, { reason: 'customer ne bill cancel kiya' }).catch(() => {});
  try { stopOrderTrackingAuto(order.id); } catch {}
  updateDraft(uidStr, {
    cart: order.cart || '',
    address: order.address || '',
    addressOriginalText: order.addressOriginalText || order.address || '',
    cartDetails: order.cartDetails || { restaurantName: order.restaurantName, items: order.items, subtotal: order.subtotal },
    addressDetails: order.addressDetails || null
  });
  return { ok: true, message: 'Order returned to your Telegram order screen so you can edit the Cart or Address.' };
}


// ---------------------------------------------------------------------------
// DELEGATED CUSTOMER SESSION & LIVE DELIVERY MILESTONE ENGINE
// ---------------------------------------------------------------------------
// When Abbu/Ammi (or any customer) approves the bill, the selected Swiggy
// account JSON session is dedicated to their order context (`injectedSession`)
// so orders don't burden a single central state. Live delivery milestones
// (Heading to restaurant, Delivery partner name, Call partner, Swiggy order
// account, OTP, ETA, Tracking link) are streamed directly to the customer in
// Telegram. Once delivery is successful, the session is auto-logged out from
// the order context and auto-exported back into Boss's central account vault.

export function injectAccountSessionIntoOrder(order, preferredAccKey = null) {
  if (!order) return null;
  const db = getDb();
  const accKey = preferredAccKey || order.selectedAccount || getActiveOrderAccountKey();
  const acc = db.config?.accounts?.[accKey] || null;
  const phone = String(acc?.phone || acc?.mobile || order.orderAccount || order.selectedAccountPhone || '').trim();
  const name = String(acc?.name || order.selectedAccountName || 'Swiggy Account').trim();
  const hasAuth = Boolean(acc && (acc.token || acc.tid || acc.cookies || acc._session_tid));

  order.injectedSession = {
    accountKey: accKey || (phone ? `acc_${phone}` : 'unknown'),
    phone,
    name,
    hasAuth,
    system: 'CUSTOMER_SESSION',
    injectedAt: new Date().toISOString()
  };
  order.injectedSessionStatus = 'ACTIVE';

  if (phone) {
    if (!order.orderAccount) order.orderAccount = phone;
    if (!order.selectedAccountPhone) order.selectedAccountPhone = phone;
  }
  if (accKey && !order.selectedAccount) {
    order.selectedAccount = accKey;
  }
  return order.injectedSession;
}

/**
 * 📱 CUSTOMER PHONE HANDOVER (boss 29-10-2026):
 * jis ID par ₹50 offers lock hue hain wahi ID customer ke phone par login ho, aur
 * order wahi se ho. Isse Swiggy ko Indian device/IP dikhta hai, isliye night cash
 * aur offers asli me lagte hain (Saudi/server se place karne par nahi lagte the).
 *
 * Card customer ko jata hai (boss-mirror se boss ko bhi), aur `order.deviceLogin`
 * par sirf utna likha jata hai jitna proof se pata chala.
 */
export async function sendDeviceLoginHandover(order, { telegram = null, chatId = null, force = false } = {}) {
  if (!order) return { ok: false, reason: 'no order' };
  // Boss (29-10-2026): "itni burhe ammi se OTP kaise parhaunga" — yeh card
  // OPTIONAL hai. `DEVICE_LOGIN_AUTO_HANDOVER=0` se bilkul band, aur ek order
  // par sirf ek baar (spam nahi).
  if (!force && String(process.env.DEVICE_LOGIN_AUTO_HANDOVER ?? '1') === '0') {
    return { ok: false, reason: 'auto handover off (DEVICE_LOGIN_AUTO_HANDOVER=0)' };
  }
  if (!force && order.deviceLogin?.handoverSentAt) {
    return { ok: false, reason: 'handover pehle hi bhej diya (dobara nahi)', phone: order.deviceLogin.phone };
  }
  const db = getDb();
  const accKey = order.selectedAccount || order.injectedSession?.accountKey || '';
  const acc = accKey ? db.config?.accounts?.[accKey] : null;
  if (!acc) return { ok: false, reason: 'ID nahi mili (account vault me nahi)' };
  const phone = deviceAccountPhone(acc, accKey);
  if (!phone) return { ok: false, reason: 'ID me phone number nahi — handover possible nahi' };

  attachDeviceLogin(order, acc, { key: accKey });
  const card = buildDeviceLoginHandover({ order, account: acc, key: accKey });

  const target = chatId || order.userChatId || order.userId || null;
  const tg = telegram || (typeof bot !== 'undefined' ? bot?.telegram : null);
  let sent = false;
  if (tg && target) {
    try {
      await tg.sendMessage(target, card.text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(card.buttons) });
      sent = true;
    } catch (err) {
      console.warn('[DeviceLogin] handover card send fail:', err?.message || err);
    }
  }
  if (sent) markHandoverSent(order);
  db.orders[order.id] = order;
  saveDb(db);
  return { ok: true, sent, phone, text: card.text, buttons: card.buttons, deviceLogin: order.deviceLogin };
}

/**
 * 📱 SHORT NOTICE (boss 30-10-2026):
 * "ye option mat de, kiu faltu experience kharab kar raha — login par click karne
 *  se JSON active in their phone, then bill show, QR par click kare to agar QR
 *  generate ho to fee payment karne bol, phir QR bas."
 *
 * Isliye lamba "optional padhiye / OTP / bot kare" card customer ko NAHI jata.
 * Bas ek line: kaunsi ID phone par active hai. Koi button, koi option nahi.
 */
/**
 * Live probe chala kar order par sach likho. Return `{ probe, truth }`.
 * (Customer ke phone ko bot dekh nahi sakta — sirf session ka live sach.)
 */
export async function refreshDeviceLoginTruth(orderId, { fetchImpl = globalThis.fetch } = {}) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { ok: false, reason: 'order nahi mila' };
  const accKey = order.selectedAccount || order.deviceLogin?.accountKey || '';
  const acc = accKey ? db.config?.accounts?.[accKey] : null;
  if (!acc) return { ok: false, reason: 'ID nahi mili' };
  attachDeviceLogin(order, acc, { key: accKey });
  const probe = await verifyAccountSessionLive(acc, { fetchImpl });
  applySessionProbe(order, probe);
  db.orders[orderId] = order;
  saveDb(db);
  return { ok: true, probe, truth: deviceLoginTruth(order), order };
}

// ── 🔒 ORDER ACCOUNT LOCK (boss 29-10-2026) ────────────────────────────────
// "jo ID zero order wali hogi uska JSON Ammi ke phone se login hoga → bill → QR →
//  link → updates. After deliver ya cancel, account wapas mere vault me — tab tak
//  wo Abbu ko bhi assign na ho."
//
// Lock disk par rehta hai (`acc.orderLock`), selection usko busy maanti hai, aur
// order band hone par (deliver/cancel) lock chhoot kar ID wapas pool me aa jati hai.

/** Selected ID ko is order ke naam par lock karo + customer ke phone par handover. */
export async function lockOrderAccountAndHandover(order, accKey = '', { telegram = null, chatId = null } = {}) {
  if (!order?.id) return { ok: false, reason: 'no order' };
  const key = String(accKey || order.selectedAccount || '').trim();
  if (!key) return { ok: false, reason: 'koi ID select nahi hui' };
  const db = getDb();
  const acc = db.config?.accounts?.[key];
  if (!acc) return { ok: false, reason: 'ID vault me nahi' };

  const res = lockAccountToOrder(db, key, order, { phone: acc.phone || acc.mobile || '' });
  if (res?.conflict) {
    saveDb(db);
    return {
      ok: false,
      code: 'ACCOUNT_LOCKED_FOR_OTHER_ORDER',
      reason: `ID ${acc.phone || key} pehle se order #${res.lock?.orderId} par locked hai — us order ke deliver/cancel hone tak nahi milegi`,
      orderId: res.lock?.orderId
    };
  }
  order.accountLockedAt = res?.lock?.at || new Date().toISOString();
  order.lockedAccount = key;
  db.orders[order.id] = order;
  saveDb(db);

  // 🚫 Boss (30-10-2026): "you are unable to inject the so remove it".
  // JSON/cookie kisi phone me inject nahi hota — isliye customer ko "ID ready /
  // login ho gaya" jaisa koi message nahi jata. Customer ko bas bill milta hai.
  const handover = null;

  // Boss ko sach: kaunsi ID kis order par atki hai.
  try {
    const bossIds = [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))];
    for (const bossId of bossIds) {
      bot.telegram.sendMessage(
        bossId,
        `🔒 <b>ID LOCKED TO ORDER</b>\n` +
        `▪ Order: <code>#${escapeHtml(String(order.id))}</code> (${escapeHtml(String(order.customerName || order.userName || order.userId || 'Customer'))})\n` +
        `▪ ID: <code>${escapeHtml(String(acc.phone || key))}</code>${acc.isZeroOrderAccount ? ' · ★ 0-order' : ''}\n` +
        `▪ Ab yeh ID kisi aur order (Abbu ka bhi) ko nahi milegi — deliver/cancel hone par wapas vault me.\n` +
        `\u26A0\uFE0F <i>Sach: JSON/cookie = bot ke server ka session. Isse order chalta hai, par customer ke phone me login NAHI hota — wo sirf us phone par OTP daalne se hota hai. Customer ko asli steps dene ke liye uska “📱 Phone me login karna hai?” button dabaiye.</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch { /* message optional, lock important */ }
  return { ok: true, locked: true, accountKey: key, handover, lock: res?.lock || null };
}

/**
 * Order band hua (deliver / cancel) → lock chhodo, aur zarurat ho to JSON boss ko
 * export karke customer ke phone se logout karo. Return me asli sach.
 */
export async function closeOrderAccountLock(orderId, { reason = '', telegram = null } = {}) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return { ok: false, reason: 'order nahi mila' };
  const plan = planAccountReturnOnClose(order);
  if (!plan.shouldRelease) return { ok: false, reason: plan.reason, plan };
  // Delivery wala auto-export pehle ho chuka ho to file dobara nahi bhejte.
  if (plan.shouldExport && order.autoExportDoneAt) {
    plan.shouldExport = false;
    plan.shouldLogout = false;
    plan.alreadyExportedAt = order.autoExportDoneAt;
    plan.reason = `${plan.reason} (export pehle ho chuka ${String(order.autoExportDoneAt).slice(0, 19)})`;
  }

  const key = plan.accountKey;
  let released = null;
  if (key) {
    released = releaseAccountLock(db, key, {
      orderId: order.id,
      reason: reason || plan.reason
    });
    // Purani in-memory 90s reservation bhi chhodo.
    try { releaseSwiggyAccountReservation(key, order.id); } catch {}
  }
  order.accountLockReleasedAt = new Date().toISOString();
  order.accountLockReleaseReason = reason || plan.reason;
  db.orders[orderId] = order;
  saveDb(db);

  // 💰 Service fee refund — SIRF jab order Swiggy par place nahi hua.
  // (Boss: "cancel par refund, par place ho chuka ho to nahi.")
  let feeRefund = null;
  try {
    const feeUserId = String(order.feeWalletUserId || order.fwdSenderUserId || order.userId || '');
    if (feeUserId) {
      const rfDb = getDb();
      const feeOrder = rfDb.orders?.[orderId] || order;
      // A dispatched or unreadable journal means the provider outcome is
      // uncertain: do not refund as if no order existed.
      const placement = readSwiggyPlacement(`chat:${String(orderId)}`);
      const rf = placement
        ? { ok: false, code: 'ORDER_PLACED_NO_REFUND', chargedPaise: Number(feeOrder.feeChargedPaise || 0) }
        : refundServiceFee(rfDb, feeOrder, feeUserId, { reason: reason || plan.reason, actor: 'auto' });
      if (rf.ok) {
        rfDb.orders[orderId] = feeOrder;
        if (!saveDbDurable(rfDb)) throw new Error('Wallet refund could not be saved');
        feeRefund = rf;
        await bot.telegram.sendMessage(
          feeUserId,
          `↩️ <b>₹${walletRupees(rf.refundedPaise)} order fee wapas</b> — order <code>#${escapeHtml(String(orderId))}</code> place hone se pehle band hua.
` +
          `<i>Ab balance ₹${walletRupees(rf.balancePaise)} hai.</i>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      } else if (rf.code === 'ORDER_PLACED_NO_REFUND') {
        feeRefund = rf;
        // Boss ka rule: place ho chuka → refund nahi. Customer ko saaf bata do.
        await bot.telegram.sendMessage(
          feeUserId,
          `ℹ️ Order <code>#${escapeHtml(String(orderId))}</code> ka Swiggy result check karein. ` +
          `Placement ho chuka ya pending ho sakta hai, isliye fee abhi auto-refund nahi hui.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[Wallet] fee refund check failed:', err?.message || err);
  }

  let exported = null;
  if (plan.shouldExport && key) {
    exported = await exportAndLogoutClosedOrder(orderId, { key, plan, telegram }).catch((err) => ({ exported: false, reason: String(err?.message || err) }));
  }
  return { ok: true, plan, released, exported, feeRefund };
}

/**
 * Cancelled order ke liye export + logout (delivered wale se alag, kyunki wahan
 * `planDeliveryExport` delivery maangta hai). File PEHLE boss ko, logout baad me.
 */
async function exportAndLogoutClosedOrder(orderId, { key, plan, telegram = null }) {
  const db = getDb();
  const order = db.orders?.[orderId];
  const acc = db.config?.accounts?.[key];
  const tg = telegram || bot?.telegram;
  const bossIds = [...new Set((db.config?.bossIds || []).map(String).filter(Boolean))];
  const bossChatId = bossIds[0] || Number(process.env.BOSS_ID || 0);
  if (!order || !acc || !bossChatId || !tg) {
    return { exported: false, reason: 'order/ID/boss chat nahi mila' };
  }
  const payload = buildExportPayload(acc, key, {
    orderCount: Number(acc.totalOrdersCount) || 0,
    prefix: `⇧ AUTO EXPORT (${plan.status.toLowerCase()})`
  });
  let sent = false;
  try {
    await tg.sendDocument(
      bossChatId,
      { source: Buffer.from(payload.jsonText, 'utf8'), filename: payload.fileName },
      { caption: payload.caption, parse_mode: 'HTML' }
    );
    sent = true;
  } catch (err) {
    return { exported: false, reason: `Telegram: ${String(err?.message || err).slice(0, 120)}` };
  }
  // File boss ke paas pahunch gayi — ab customer ke phone se session band.
  let loggedOut = false;
  if (plan.shouldLogout) {
    try {
      await deactivateSwiggyAccountViaBridge(bossChatId, key, true);
      loggedOut = true;
    } catch { loggedOut = false; }
    try {
      permanentLogoutAccount(key, { purgeVault: true });
      deleteAccount(key, { purgeVault: true });
    } catch {}
  }
  const freshDb = getDb();
  const freshOrder = freshDb.orders?.[orderId];
  if (freshOrder) {
    freshOrder.autoExportDoneAt = new Date().toISOString();
    freshOrder.autoExportAccountKey = key;
    freshOrder.autoExportFile = payload.fileName;
    saveDb(freshDb);
  }
  try {
    await tg.sendMessage(
      bossChatId,
      `<blockquote>⇧ <b>AUTO EXPORT &amp; LOGOUT — ${escapeHtml(String(plan.status))}</b></blockquote>\n` +
      `▪ Order: <code>#${escapeHtml(String(orderId))}</code>${order.swiggyOrderId ? ` (Swiggy <code>${escapeHtml(String(order.swiggyOrderId))}</code>)` : ''}\n` +
      `▪ Account: <code>${escapeHtml(payload.phone)}</code> · vault: ${loggedOut ? '✓ logged out &amp; removed' : '⚠️ logout confirm nahi'}\n` +
      `▪ File: <code>${escapeHtml(payload.fileName)}</code>\n` +
      `<i>${escapeHtml(plan.reason)}</i>`,
      { parse_mode: 'HTML' }
    );
  } catch {}
  return { exported: sent, loggedOut, phone: payload.phone, fileName: payload.fileName };
}

/**
 * Terminal orders ke adhoore locks ka sweep (bot restart / missed callback ke
 * baad bhi ID vault me wapas aani chahiye). Har 10 min + boot par chalta hai.
 */
export function runAccountLockSweep({ limit = 6 } = {}) {
  const db = getDb();
  let changed = false;
  const swept = sweepAccountLocks(db);
  if (swept.released.length) changed = true;
  if (changed) saveDb(db);

  // Jo terminal order abhi tak close-handle nahi hue, unhe abhi handle karo.
  const pending = Object.values(getDb().orders || {})
    .filter((o) => o && o.id && isTerminalOrderStatus(o.status) && !o.accountLockReleasedAt)
    .filter((o) => o.selectedAccount || o.lockedAccount || o.injectedSession?.accountKey)
    .slice(0, limit);
  for (const o of pending) {
    closeOrderAccountLock(o.id, { reason: 'sweep: order band ho chuka hai' }).catch(() => {});
  }
  return { swept: swept.released, pending: pending.map((o) => o.id) };
}

export function releaseAndExportInjectedSessionOnDelivery(orderId) {
  const db = getDb();
  const order = db.orders?.[orderId];
  if (!order) return false;
  // 🔒 Delivered — lock chhod do (ID wapas vault pool me).
  try {
    const accKeyForLock = order.selectedAccount || order.injectedSession?.accountKey;
    if (accKeyForLock) releaseAccountLock(db, accKeyForLock, { orderId, reason: 'order delivered' });
  } catch {}

  const accKey = order.selectedAccount || order.injectedSession?.accountKey;
  order.injectedSessionStatus = 'DELIVERED_RELEASED';
  order.injectedSessionReleasedAt = new Date().toISOString();

  if (accKey) {
    try { releaseSwiggyAccountReservation(accKey, order.id); } catch {}
    const acc = db.config?.accounts?.[accKey];
    if (acc) {
      acc.totalOrdersCount = (Number(acc.totalOrdersCount) || 0) + 1;
      acc.lastOrderTime = new Date().toISOString();
      acc.isZeroOrderAccount = false;
      db.config.accounts[accKey] = acc;
    }
  }

  saveDb(db);
  try {
    syncAccountsJsonMirror(db);
  } catch (err) {
    console.warn('[SessionExport] syncAccountsJsonMirror failed:', err?.message || err);
  }
  return true;
}

// Auto export + logout for a delivered order. Safe to call repeatedly — the
// planner refuses a second time, refuses while the ID has another live order,
// and refuses when the session is already gone.
async function autoExportDeliveredOrder(orderId) {
  const deliveredOrderId = String(orderId || '');
  if (!deliveredOrderId) return { exported: false, reason: 'no order id' };
  const db = getDb();
  const order = db.orders?.[deliveredOrderId];
  if (!order) return { exported: false, reason: 'order not found' };
  if (order.autoExportDoneAt) return { exported: false, reason: 'already auto-exported' };

  const bossChatId = Number(getDb().config?.bossIds?.[0] || process.env.BOSS_ID || 0);
  if (!bossChatId) return { exported: false, reason: 'no boss chat id' };

  const result = await autoExportAccountAfterDelivery(deliveredOrderId, {
    getDb,
    saveDb,
    bossChatId,
    sendDocument: async (chatId, fileName, text, caption) => {
      await bot.telegram.sendDocument(
        chatId,
        { source: Buffer.from(text, 'utf8'), filename: fileName },
        { caption, parse_mode: 'HTML' }
      );
    },
    notifyBoss: async (text) => {
      await bot.telegram.sendMessage(bossChatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    },
    logoutAccount: async (key) => {
      // Logout from Swiggy's device list first (best effort), then wipe local.
      await deactivateSwiggyAccountViaBridge(bossChatId, key, true).catch(() => {});
      permanentLogoutAccount(key, { purgeVault: true });
      deleteAccount(key, { purgeVault: true });
    }
  }).catch((err) => ({ exported: false, reason: String(err?.message || err) }));

  return result;
}

export { autoExportDeliveredOrder };

const customerMilestoneInFlight = new Set();

export async function pushCustomerLiveDeliveryMilestone(order, { scan = null, force = false } = {}) {
  const orderId = String(order?.id || '');
  if (!orderId) return false;
  if (customerMilestoneInFlight.has(orderId)) return false;
  customerMilestoneInFlight.add(orderId);

  try {
    const db = getDb();
    const fresh = db.orders?.[orderId] || order;
    if (['CANCELLED', 'REJECTED'].includes(String(fresh.status || ''))) return false;

    const isDelivered = /delivered/i.test(String(fresh.liveOrderStatus || ''));
    if (isDelivered && fresh.injectedSessionStatus === 'ACTIVE') {
      releaseAndExportInjectedSessionOnDelivery(orderId);
      fresh.injectedSessionStatus = 'DELIVERED_RELEASED';
    }
    // AUTO EXPORT & LOGOUT once the order is delivered (Boss ki shart):
    // the 7-field JSON is sent to the Boss and then the account leaves the
    // vault — exactly like tapping "⇧ Export & Logout", but by itself.
    if (isDelivered) {
      autoExportDeliveredOrder(orderId).catch((err) => {
        console.warn('[AutoExport] failed:', err?.message || err);
      });
    }

    const chatId = String(
      fresh.userChatId ||
      fresh.chatId ||
      (fresh.isForwardedOrder && fresh.fwdSenderUserId ? fresh.fwdSenderUserId : fresh.userId) ||
      fresh.userId ||
      ''
    ).trim();

    if (!chatId) return false;

    if (!fresh.injectedSession) {
      injectAccountSessionIntoOrder(fresh, fresh.selectedAccount);
    }

    const milestoneSnapshot = [
      fresh.liveOrderStatus || '',
      fresh.deliveryBoyName || '',
      fresh.deliveryBoyMobile || '',
      fresh.deliveryOtp || '',
      getStoredSwiggyTrackingUrl(fresh) || '',
      fresh.injectedSessionStatus || ''
    ].join('|');

    if (!force && fresh.customerLastMilestoneSent === milestoneSnapshot) {
      return false;
    }

    const msg = buildSimpleTrackingMessage(fresh, { milestoneUpdate: true });
    await bot.telegram.sendMessage(chatId, msg.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...msg.keyboard
    });

    const afterDb = getDb();
    if (afterDb.orders?.[orderId]) {
      afterDb.orders[orderId].customerLastMilestoneSent = milestoneSnapshot;
      afterDb.orders[orderId].customerLastMilestoneSentAt = new Date().toISOString();
      saveDb(afterDb);
    }
    return true;
  } catch (err) {
    console.warn('[CustomerMilestone] Push failed:', err?.message || err);
    return false;
  } finally {
    customerMilestoneInFlight.delete(orderId);
  }
}

// Helper: auto-edit the customer payment message in-place to inject tracking link/OTP after Swiggy payment (user request: payment message edit hokar usme link ajaye)
// SIMPLE MODE TRACKING: the customer always gets ONE chat bubble with the real
// Swiggy tracking link, even if the payment-QR message was deleted. Sent once per
// Swiggy link (guarded by `simpleTrackingSentFor`), never fabricated.
const simpleTrackingInFlight = new Set();

async function sendSimpleTrackingOnce(order) {
  const guardKey = String(order?.id || '');
  if (!guardKey) return false;
  // Two sources can discover the link at the same moment (payment poll + tracking
  // auto-scan). Serialise them so the customer never gets the bubble twice.
  if (simpleTrackingInFlight.has(guardKey)) return false;
  simpleTrackingInFlight.add(guardKey);
  try {
    if (!isSimpleChatEnabled() || !order?.id) return false;
    if (['CANCELLED', 'REJECTED'].includes(String(order.status || ''))) return false;
    const url = simpleTrackingUrl(order);
    if (!url) return false;
    const chatId = String(
      order.userChatId ||
      order.chatId ||
      (order.isForwardedOrder && order.fwdSenderUserId ? order.fwdSenderUserId : order.userId) ||
      order.userId ||
      ''
    ).trim();
    if (!chatId) return false;
    const db = getDb();
    const fresh = db.orders?.[order.id] || order;
    if (fresh.simpleTrackingSentFor === url) return false;
    const msg = buildSimpleTrackingMessage(fresh);
    await bot.telegram.sendMessage(chatId, msg.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...msg.keyboard
    });
    const after = getDb();
    if (after.orders?.[order.id]) {
      after.orders[order.id].simpleTrackingSentFor = url;
      after.orders[order.id].simpleTrackingSentAt = new Date().toISOString();
      saveDb(after);
    }
    return true;
  } catch (err) {
    console.warn('[SimpleChat] Tracking send failed:', err?.message || err);
    return false;
  } finally {
    simpleTrackingInFlight.delete(guardKey);
  }
}

async function tryEditCustomerPaymentMessageWithTracking(order) {
  if (!order || !bot?.telegram) return false;
  const msgId = order.customerPaymentMessageId || order.activeQrMessageId || null;
  if (!msgId) return false;
  const chatId = String(
    order.userChatId ||
    order.chatId ||
    (order.isForwardedOrder && order.fwdSenderUserId ? order.fwdSenderUserId : order.userId) ||
    order.userId ||
    ''
  ).trim();
  if (!chatId) return false;
  const trackingUrl = getStoredSwiggyTrackingUrl(order);
  const swiggyId = String(order.swiggyOrderId || order.pendingSwiggyOrderId || order.id || '').trim();
  const restName = String(order.restaurantName || 'Swiggy Order').trim();
  const amt = Number(order.finalPayable || order.finalTotal || 0);
  const otp = String(order.deliveryOtp || '').trim();
  const swiggyPhone = String(order.orderAccount || order.selectedAccountPhone || order.injectedSession?.phone || '').trim();

  // Build success caption — same style as forwarded edit helper
  let caption = '';
  if (trackingUrl) {
    caption = `\u2705 <b>PAYMENT VERIFIED \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (swiggyPhone ? `📱 <b>Swiggy Account:</b> <code>${escapeHtml(swiggyPhone)}</code>\n` : '') +
      `⚡ <b>Swiggy Session:</b> <i>Injected into customer context</i>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      (order.etaMinutes ? `\u23F1\uFE0F <b>ETA:</b> ${escapeHtml(String(order.etaMinutes))} min\n` : '') +
      (otp ? `\uD83D\uDD22 <b>Delivery OTP:</b> <code>${escapeHtml(otp)}</code>\n` : '') +
      `\n\uD83D\uDD17 <b>Live Tracking Link:</b>\n<a href="${escapeHtml(trackingUrl)}">${escapeHtml(trackingUrl)}</a>\n\n` +
      `<i>Swiggy payment confirmed — tap tracking to follow rider live.</i>`;
  } else {
    caption = `\u2705 <b>PAYMENT VERIFIED \u2014 ORDER CONFIRMED (#${escapeHtml(order.id)})</b>\n` +
      `\uD83D\uDCE6 <b>${escapeHtml(restName)}</b>\n` +
      (amt ? `\uD83D\uDCB0 <b>Paid:</b> \u20B9${amt}\n` : '') +
      `\uD83C\uDD94 <b>Swiggy ID:</b> <code>${escapeHtml(swiggyId)}</code>\n` +
      (swiggyPhone ? `📱 <b>Swiggy Account:</b> <code>${escapeHtml(swiggyPhone)}</code>\n` : '') +
      `⚡ <b>Swiggy Session:</b> <i>Injected into customer context</i>\n` +
      (order.liveOrderStatus ? `\uD83D\uDCCB <b>Status:</b> ${escapeHtml(String(order.liveOrderStatus))}\n` : '') +
      `\n<i>\u2713 Payment verified on Swiggy. Live delivery updates will be sent here as new messages.</i>`;
  }

  const rows = [];
  if (trackingUrl) rows.push([Markup.button.url('\uD83D\uDD17 Track Order Live', trackingUrl)]);
  if (otp) rows.push([{ text: `\uD83D\uDCCB Copy OTP ${otp}`, copy_text: { text: String(otp) } }]);
  // Keep live refresh button so customer can tap without ever getting an error:
  rows.push([{ text: '🔄 Refresh status', callback_data: `user_paid_status_${order.id}` }]);
  const kb = rows.length ? Markup.inlineKeyboard(rows) : { reply_markup: { inline_keyboard: [] } };

  try {
    await bot.telegram.editMessageCaption(chatId, msgId, undefined, caption, { parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  try {
    await bot.telegram.editMessageText(caption, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...kb });
    return true;
  } catch {}
  return false;
}


async function checkOrderPaidStatusOnly(orderId) {
  const db = getDb();
  let order = lookupOrder(db, orderId) || db.orders?.[orderId];
  if (!order) {
    for (const o of Object.values(db.orders || {})) {
      if (o && (o.id === orderId || o.swiggyOrderId === orderId || String(o.id).endsWith(String(orderId)))) {
        order = o;
        break;
      }
    }
  }
  if (!order) return { paid: false, message: 'Order not found.' };
  if (!order.injectedSession) {
    injectAccountSessionIntoOrder(order, order.selectedAccount);
  }
  const wasAlreadyCompleted = order.status === 'COMPLETED';
  const acc = order.selectedAccount ? db.config?.accounts?.[order.selectedAccount] : null;
  if (!acc) {
    // Try All-IDs extract as fallback when selected account missing but order already paid (delay case: I have paid click)
    if (wasAlreadyCompleted && !getStoredSwiggyTrackingUrl(order)) {
      try {
        const fallback = typeof extractTrackingViaAllAccounts === 'function'
          ? await extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null)
          : null;
        if (fallback?.trackingUrl) {
          // persisted inside extractTrackingViaAllAccounts; reload
          const fresh = getDb().orders?.[orderId];
          if (fresh) { order.trackingLink = fresh.trackingLink; order.trackingLinkSource = fresh.trackingLinkSource; }
        }
      } catch {}
    }
    const trackingLink = getStoredSwiggyTrackingUrl(order);
    if (wasAlreadyCompleted) {
      // Auto-edit payment message to inject link on delayed I-have-paid click
      try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}
    }
    return wasAlreadyCompleted
      ? { paid: true, trackingLink, deliveryOtp: order.deliveryOtp || '', message: trackingLink ? '✓ Swiggy tracking is available.' : '… Swiggy has not shared a tracking link yet.' }
      : { paid: false, message: 'Waiting for verified payment on the Swiggy gateway (status check only).' };
  }

  let check;
  try {
    check = await checkRealSwiggyPaymentAndExtractTracking(acc, order);
  } catch (checkErr) {
    const errMsg = String(checkErr?.message || checkErr || 'unknown');
    const diag = checkErr?.diag ? ' diag=' + JSON.stringify(checkErr.diag) : '';
    return {
      paid: false,
      message: ('! Swiggy verify failed: ' + errMsg + diag).slice(0, 190)
    };
  }
  if (!check?.paid) {
    if (wasAlreadyCompleted) {
      // Delay case: I have paid already true but tracking still pending — try All-IDs live extract before responding
      if (!getStoredSwiggyTrackingUrl(order)) {
        try {
          const fallback = typeof extractTrackingViaAllAccounts === 'function'
            ? await extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null)
            : null;
          if (fallback?.trackingUrl) {
            const fresh2 = getDb().orders?.[orderId];
            if (fresh2) { order.trackingLink = fresh2.trackingLink; order.trackingLinkSource = fresh2.trackingLinkSource; order.deliveryOtp = fresh2.deliveryOtp || order.deliveryOtp; }
          }
        } catch {}
      }
      const trackingLink = getStoredSwiggyTrackingUrl(order);
      try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}
      return {
        paid: true,
        trackingLink,
        deliveryOtp: order.deliveryOtp || '',
        message: trackingLink ? '✓ Payment is verified; Swiggy tracking is available.' : '✓ Payment is verified. Swiggy has not published tracking yet.'
      };
    }
    // Delay rescue: primary ID says pending but payment may have settled on another saved account — try All-IDs before declaring pending
    // This satisfies user request: "I have paid" click par turant link aa jaye even if gateway delayed
    if (!getStoredSwiggyTrackingUrl(order)) {
      try {
        const rescue = typeof extractTrackingViaAllAccounts === 'function'
          ? await extractTrackingViaAllAccounts(order, { getAccountsFn: () => getDb().config.accounts }).catch(() => null)
          : null;
        if (rescue?.trackingUrl) {
          const freshRescue = getDb().orders?.[orderId];
          if (freshRescue) {
            order.trackingLink = freshRescue.trackingLink || rescue.trackingUrl;
            order.trackingLinkSource = freshRescue.trackingLinkSource || 'SWIGGY_API';
            order.deliveryOtp = freshRescue.deliveryOtp || rescue.res?.deliveryOtp || order.deliveryOtp;
            order.swiggyOrderId = freshRescue.swiggyOrderId || rescue.res?.swiggyOrderId || order.swiggyOrderId;
            order.liveOrderStatus = freshRescue.liveOrderStatus || rescue.res?.orderStatus || order.liveOrderStatus;
          } else {
            order.trackingLink = rescue.trackingUrl;
            order.trackingLinkSource = 'SWIGGY_API';
            order.deliveryOtp = rescue.res?.deliveryOtp || order.deliveryOtp;
            order.swiggyOrderId = rescue.res?.swiggyOrderId || order.swiggyOrderId;
          }
          order.status = 'COMPLETED';
          order.cardStage = 'PAID_CONFIRMED';
          order.paidAt = new Date().toISOString();
          order.uxStage = 'SCREEN_05_TRACKING_READY';
          saveDb(getDb());
          try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}
          const firstBossChatId2 = getDb().config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
          try { await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId2, order); } catch {}
          try { startOrderDeliveryInfoPoller({ telegram: bot.telegram, chatId: firstBossChatId2, orderId: order.id, formatOrderBodyFn: formatUserOrderCardText }); } catch {}
          try { startOrderTrackingAuto(order.id, { budgetMs: 12000, force: true, delays: PAYMENT_TRACKING_DELAYS }); } catch {}
          const t2 = getStoredSwiggyTrackingUrl(order);
          return { paid: true, trackingLink: t2, deliveryOtp: order.deliveryOtp || '', message: t2 ? '✓ Payment verified via linked Swiggy account. Swiggy tracking is available.' : 'Payment verified successfully. Swiggy tracking is not available yet. I\'ll retry shortly.' };
        }
      } catch {}
    }
    const dbg = [];
    if (check?.txnState) dbg.push('txn=' + check.txnState);
    if (check?.payTxnState) dbg.push('pay=' + check.payTxnState);
    if (check?.gatewayFetchError) dbg.push('gwErr=' + String(check.gatewayFetchError).slice(0,40));
    if (check?.postStatusLower) dbg.push('post=' + check.postStatusLower);
    if (!dbg.length && check) dbg.push(JSON.stringify(check).slice(0,80));
    return {
      paid: false,
      message: ('◷ Still pending' + (dbg.length ? ' (' + dbg.join(' ') + ')' : '') + ' — will auto-detect every 5s. If you paid, wait 30s and try again.').slice(0,180)
    };
  }

  if (order.selectedAccount) releaseSwiggyAccountReservation(order.selectedAccount, order.id);
  order.status = 'COMPLETED';
  order.swiggyOrderId = check.swiggyOrderId || order.pendingSwiggyOrderId || order.swiggyOrderId || '';
  // 📱 Agar customer ne apne phone se order kiya tha, to usi ID par aaya yeh
  // order hi PAKKA proof hai (bot ka jhootha "login ho gaya" nahi).
  if (order.swiggyOrderId && noteCustomerPlacedOrder(order, order.swiggyOrderId)) {
    try {
      const bossIds = [...new Set((db.config?.bossIds || []).map(String).filter(Boolean))];
      const proofText = `✅ <b>ORDER CUSTOMER KE PHONE SE PLACE HUA</b>\n` +
        `Order: <code>#${escapeHtml(String(order.swiggyOrderId))}</code> · Swiggy ID: <code>${escapeHtml(String(order.deviceLogin?.phone || order.orderAccount || ''))}</code>\n` +
        `<i>Usi ID par order dikha — phone login confirm.</i>`;
      for (const chatId of [String(order.userChatId || order.userId || ''), ...bossIds].filter(Boolean)) {
        bot.telegram.sendMessage(chatId, proofText, { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch { /* proof likhna important hai, message nahi */ }
  }
  order.liveOrderStatus = check.orderStatus || order.liveOrderStatus || 'Order Confirmed';
  const trackingCandidate = check.nativeShareUrl || check.swiggyWebTrackUrl || '';
  const providerTrackingUrl = trackingCandidate
    ? getStoredSwiggyTrackingUrl({ trackingLink: trackingCandidate, trackingLinkSource: 'SWIGGY_API' })
    : '';
  const existingTrustedTrackingUrl = getStoredSwiggyTrackingUrl(order);
  order.trackingLink = providerTrackingUrl || existingTrustedTrackingUrl;
  order.trackingLinkSource = providerTrackingUrl ? 'SWIGGY_API' : (existingTrustedTrackingUrl ? order.trackingLinkSource : '');
  order.shareTrackUrl = '';
  order.deliveryOtp = check.deliveryOtp || order.deliveryOtp || '';
  order.deliveryBoyName = check.deliveryBoy?.name || order.deliveryBoyName || '';
  order.deliveryBoyMobile = check.deliveryBoy?.mobile || order.deliveryBoyMobile || '';
  order.uxStage = getStoredSwiggyTrackingUrl(order) ? 'SCREEN_05_TRACKING_READY' : 'SCREEN_05_PAID_TRACKING_DELAYED';
  saveDb(db);

  // Auto-edit the customer's payment QR message in-place to inject tracking link/OTP (Swiggy payment hote hi edit)
  try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}
  // Simple chat: also drop clean tracking bubble with a tap-to-track button.
  try { await sendSimpleTrackingOnce(order); } catch {}
  try { await pushCustomerLiveDeliveryMilestone(order, { force: true }); } catch {}

  const firstBossChatId = db.config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
  await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId, order);
  startOrderDeliveryInfoPoller({
    telegram: bot.telegram,
    chatId: firstBossChatId,
    orderId: order.id,
    formatOrderBodyFn: formatUserOrderCardText
  });
  // Payment is confirmed — fetch the real Swiggy share link & live delivery milestones automatically.
  // No button, no manual "Extract Tracking Link" needed. PAYMENT profile: Swiggy
  // often publishes the OFO link 10–120s after payment, so poll every 5–60s in
  // that window instead of waiting for the 3-minute step of the default ladder.
  try { startOrderTrackingAuto(order.id, { budgetMs: 15000, trackMilestones: true, force: true, delays: PAYMENT_TRACKING_DELAYS }); } catch {}

  const trackingLink = getStoredSwiggyTrackingUrl(order);
  return {
    paid: true,
    trackingLink,
    deliveryOtp: order.deliveryOtp || '',
    message: trackingLink
      ? '✓ Payment verified. Swiggy tracking is available.'
      : 'Payment verified successfully. Swiggy tracking is not available yet. I\'ll retry shortly.'
  };
}

bot.action(/^user_approve_bill_([A-Za-z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCbQuery('Checking bill approval and Swiggy payment details...').catch(() => {});
  const result = await approveUserOrderBillAction(String(ctx.from.id), ctx.match[1]);
  if (!result.ok) await ctx.reply(`! ${escapeHtml(result.error || 'Bill approval failed.')}`).catch(() => {});
});

bot.action(/^user_bill_issue_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const result = await rejectUserOrderBillAction(String(ctx.from.id), ctx.match[1]);
  if (!result.ok) return ctx.answerCbQuery(result.error || 'Could not return this order for edits.', { show_alert: true }).catch(() => {});
  await ctx.answerCbQuery('Returned to your order screen for edits.').catch(() => {});
  const screen = getUserScreen(ctx.from.id, ctx.from);
  await ctx.reply(screen.text, { parse_mode: 'HTML', ...screen.keyboard });
});

bot.action(/^user_paid_status_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const rawId = ctx.match[1];
  const db = getDb();
  let order = lookupOrder(db, rawId) || db.orders?.[rawId];
  if (!order) {
    order = getActiveUserOrder(db, ctx.from.id);
  }
  if (!order) {
    for (const o of Object.values(db.orders || {})) {
      if (o && (o.id === rawId || o.swiggyOrderId === rawId || String(o.id).endsWith(String(rawId)))) {
        order = o;
        break;
      }
    }
  }
  if (!order) {
    try {
      const scan = await ensureOrderTracking(rawId, { budgetMs: 15000, deep: true, force: true });
      order = lookupOrder(getDb(), rawId) || (scan?.orderId ? getDb().orders?.[scan.orderId] : null);
    } catch {}
  }
  if (!order) return ctx.answerCbQuery('Order not found on Swiggy.', { show_alert: true }).catch(() => {});
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: not your order.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Checking payment + live tracking…').catch(() => {});
  // 📱 Customer ke phone se place hua order ho to bot ke paas Swiggy id hoti hi
  // nahi — pehle usi ID ki "My Orders" se apna order adopt karo, warna na payment
  // check hota hai na tracking link nikalti hai (boss 30-10-2026).
  if (!order.swiggyOrderId && !order.pendingSwiggyOrderId) {
    const adopted = await adoptSwiggyOrderIdForBot(order.id, { budgetMs: 7000 }).catch(() => null);
    if (adopted?.ok) order = lookupOrder(getDb(), order.id) || order;
  }
  const res = await checkOrderPaidStatusOnly(order.id || rawId);
  try {
    const ord = lookupOrder(getDb(), order.id || rawId) || order;
    if (!ord.injectedSession) {
      injectAccountSessionIntoOrder(ord, ord.selectedAccount);
      saveDb(getDb());
    }
    const link = ord ? getStoredSwiggyTrackingUrl(ord) : '';
    // Id ho ya na ho — ladder chalta hai (khud id adopt karke link laata hai).
    if (ord && !['CANCELLED', 'REJECTED'].includes(String(ord.status || ''))) {
      try { startOrderTrackingAuto(ord.id, { budgetMs: 15000, trackMilestones: true, force: true, delays: PAYMENT_TRACKING_DELAYS }); } catch {}
    }
    // ALWAYS reply with full live status as a brand-new message in chat:
    const msg = buildSimpleTrackingMessage(ord, { milestoneUpdate: true });
    await ctx.reply(msg.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...msg.keyboard
    }).catch(async () => {
      await ctx.reply(
        `◉ ${escapeHtml(res.message)}` +
        (link ? `\n\n🔗 <b>Tracking link:</b>\n<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>` : ''),
        { parse_mode: 'HTML' }
      ).catch(() => {});
    });
  } catch {}
});

// ── 🔗 TRACKING LINK LAO (boss 30-10-2026) ─────────────────────────────────
// "same id me dusre bot me login karta to turant nikaal dete" — yahi karte hain:
// pehle usi ID se (jo order place karne wali hai), phir poora vault. Har fail par
// ASLI reason, kabhi fake link nahi.
const TRACK_FAIL_REASONS = {
  ORDER_NOT_FOUND: 'order record nahi mila',
  NO_SWIGGY_ID: 'Swiggy order id nahi mili — jis ID se order hua usme "My Orders" me order dikha do, phir try karo',
  NOT_ON_ANY_ACCOUNT: 'kisi bhi ID par ye order nahi mila (session dead / doosra number)',
  NO_ACCOUNT_CREDS: 'vault me koi logged-in ID nahi hai',
  WAF_COOLDOWN: 'Swiggy ne temporarily block kiya (WAF) — 3-5 min me dobara',
  NOT_PUBLISHED_YET: 'Swiggy ne abhi share link publish nahi kiya — order chal raha ho to 2-5 min me aa jata hai',
  AMBIGUOUS_MATCH: 'ek se zyada order mile — kaunsa aapka hai pakka nahi hua'
};

bot.action(/^track_now_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const db = getDb();
  const order = lookupOrder(db, orderId) || db.orders?.[orderId] || getActiveUserOrder(db, ctx.from.id);
  if (!order) return ctx.answerCbQuery('Order nahi mila.', { show_alert: true }).catch(() => {});
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Ye aapka order nahi.', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery('Link la raha hoon…').catch(() => {});
  const res = await extractTrackingNow(order.id, { budgetMs: 14000 }).catch((err) => ({ ok: false, reason: String(err?.message || err) }));
  const fresh = lookupOrder(getDb(), order.id) || order;

  if (res?.ok && res.url) {
    await updateOrderCards(getDb().orders?.[order.id] || fresh).catch(() => {});
    const msg = buildSimpleTrackingMessage(fresh, { milestoneUpdate: false });
    await ctx.reply(msg.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...msg.keyboard
    }).catch(() => {});
    // Boss ko bhi — dono taraf (standing rule).
    for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
      if (String(bossId) === String(ctx.from.id)) continue;
      await bot.telegram.sendMessage(
        bossId,
        `🔗 <b>TRACKING LINK MILA</b>\nOrder <code>#${escapeHtml(String(order.id))}</code>\n` +
        `<a href="${escapeHtml(res.url)}">${escapeHtml(res.url)}</a>`,
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
      ).catch(() => {});
    }
    return;
  }

  const reasonCode = String(res?.reason || 'NOT_FOUND');
  const reasonText = TRACK_FAIL_REASONS[reasonCode] || `abhi nahi mila (${reasonCode})`;
  await ctx.reply(
    `⚠️ <b>Tracking link abhi nahi mila</b>\n\n` +
    `<i>${escapeHtml(reasonText)}</i>` +
    (res?.swiggyOrderId ? `\n\nSwiggy order: <code>${escapeHtml(String(res.swiggyOrderId))}</code>` : '') +
    `\n\nOrder chal raha ho to link 2-5 min me khud aa jata hai — neeche dobara try kar sakte hain.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [{ text: '🔁 Dobara try', callback_data: `track_now_${order.id}`, style: 'success' }],
        supportRow()
      ])
    }
  ).catch(() => {});
  for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
    if (String(bossId) === String(ctx.from.id)) continue;
    await bot.telegram.sendMessage(
      bossId,
      `⚠️ <b>TRACKING LINK NAHI MILA</b>\nOrder <code>#${escapeHtml(String(order.id))}</code> · user <code>${escapeHtml(String(order.userId || ''))}</code>\n` +
      `<i>${escapeHtml(reasonCode)}</i>${res?.swiggyOrderId ? ` · swiggy <code>${escapeHtml(String(res.swiggyOrderId))}</code>` : ''}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[{ text: '🔁 Dobara try', callback_data: `track_now_${order.id}`, style: 'success' }]]) }
    ).catch(() => {});
  }
});

bot.action(/^user_resend_approved_qr_([A-Za-z0-9_-]+)$/, async (ctx) => {
  const orderId = ctx.match[1];
  const order = lookupOrder(getDb(), orderId) || getDb().orders?.[orderId] || getActiveUserOrder(getDb(), ctx.from.id);
  if (!order) return ctx.answerCbQuery('Order not found.', { show_alert: true }).catch(() => {});
  if (!isOrderCustomer(order, ctx.from.id) && !isBoss(ctx.from.id)) {
    return ctx.answerCbQuery('Unauthorized: not your order.', { show_alert: true }).catch(() => {});
  }
  if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(order.status) || !order.billApprovedByUser) {
    return ctx.answerCbQuery('No unpaid approved payment QR is available.', { show_alert: true }).catch(() => {});
  }
  // "Resend QR" jab customer ne kaha QR invalid hai: purana (dead) QR dobara
  // nahi — naya Swiggy QR banega (naya reference), warna same QR hi aata rehta.
  const reuse = shouldReusePendingQr(order, { accountPhone: order.orderAccount || '' });
  if (reuse.reuse) {
    await ctx.answerCbQuery('Wahi QR dobara bhej raha hoon (abhi bhi valid hai).').catch(() => {});
    try {
      await sendApprovedOrderPaymentToUser(String(ctx.from.id), order, { force: true });
    } catch (error) {
      await ctx.reply(`! ${escapeHtml(`Could not resend the existing Swiggy payment details: ${error.message}`)}`).catch(() => {});
    }
    return;
  }

  await ctx.answerCbQuery('Naya Swiggy QR bana raha hoon (purana valid nahi tha)…').catch(() => {});
  {
    const markDb = getDb();
    if (markDb.orders?.[order.id]) {
      markDb.orders[order.id].qrInvalidatedAt = new Date().toISOString();
      markDb.orders[order.id].qrInvalidReason = reuse.reason;
      saveDb(markDb);
    }
  }
  try {
    await executeRealQrGenerationForOrder({
      telegram: bot.telegram,
      chatId: String(ctx.from.id),
      orderId: order.id,
      formatOrderBodyFn: formatUserOrderCardText,
      forceNewQr: true
    });
    const fresh = getDb().orders?.[order.id] || order;
    const bossIds = getDb().config?.bossIds || [];
    for (const bossId of bossIds) {
      await bot.telegram.sendMessage(
        bossId,
        `↻ <b>Naya QR bheja gaya — Order #${escapeHtml(order.id)}</b>\n` +
        `▪ <b>Purana QR valid nahi tha:</b> ${escapeHtml(reuse.reason)}\n` +
        `▪ <b>Naya QR:</b> #${Number(fresh.qrVersion || 2)}${describeQrRef(fresh).ref ? ` (ref ${describeQrRef(fresh).ref})` : ''}\n` +
        `▪ <b>Amount:</b> ₹${Number(fresh.finalPayable || 0)}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch (error) {
    await ctx.reply(
      `× <b>Naya QR nahi ban paya:</b> ${escapeHtml(error.message)}\n` +
      `<i>Purana QR dobara nahi bheja gaya — wo invalid tha.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

// Lightweight health check server + Swiggy tracking endpoints + 24x7 Keep-Alive (works on Render, Railway, etc.)
const healthPort = Number(process.env.PORT || (process.env.RENDER ? 10000 : 0));
// Health JSON must tell the truth: the old payload always said "online", so a
// container whose bot never started still looked healthy to the host.
const botRuntimeState = { launched: false, launchedAt: null, bootError: null };
if (healthPort > 0) {
  const server = http.createServer(async (req, res) => {
    try {
      notePublicServiceOrigin(req);
      const reqUrl = new URL(req.url || '/', `http://localhost:${healthPort}`);
      if (await handleSwiggyProHttp(req, res, { authorizeUser: authorizeMiniAppUser, telegram: bot.telegram })) return;

      // 🤖 PAYMENT AUTO-VERIFY WEBHOOK (boss 30-10-2026)
      // "utr auto verify nahi ho raha" — ab UTR type karne ki zaroorat nahi:
      // paisa aate hi gateway/UPI app yahan POST karega aur fee khud settle
      // ho jayegi (customer ko kuch nahi karna).
      //   POST /pay/webhook  { userId, amountPaise, utr, orderId }
      //   header: x-pay-secret: <PAY_WEBHOOK_SECRET>   (ya ?secret=)
      if (reqUrl.pathname === '/pay/webhook') {
        const configuredSecret = String(process.env.PAY_WEBHOOK_SECRET || '').trim();
        const givenSecret = String(req.headers['x-pay-secret'] || reqUrl.searchParams.get('secret') || '').trim();
        const replyJson = (code, body) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return replyJson(405, { ok: false, error: 'POST only' });
        if (!configuredSecret) return replyJson(503, { ok: false, error: 'PAY_WEBHOOK_SECRET set nahi hai' });
        if (givenSecret !== configuredSecret) return replyJson(403, { ok: false, error: 'Bad secret' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 20_000) return replyJson(413, { ok: false, error: 'Body too large' });
        }
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return replyJson(400, { ok: false, error: 'Bad JSON' }); }
        const wDb = getDb();
        const orderId = String(body.orderId || body.order_id || '').trim();
        const order = orderId ? wDb.orders?.[orderId] : null;
        const userId = String(body.userId || body.user_id || order?.userId || '').trim();
        const amountPaise = Number(body.amountPaise ?? body.amount_paise ?? 0);
        const utr = String(body.utr || body.rrn || '').trim();
        const validUtr = validateUtr(utr);
        if (!validUtr.ok || !Number.isSafeInteger(amountPaise) || amountPaise < 100) {
          return replyJson(400, { ok: false, error: 'Valid UTR and actual amount (integer paise) are required.' });
        }
        const payeeName = String(body.payeeName || '');
        const payeeVpa = String(body.payeeVpa || body.vpa || '').trim();
        const configuredVpa = String(configuredWalletUpiId(wDb) || '').trim().toLowerCase();
        const payeeVerified = isBossPayee({ name: payeeName, vpa: payeeVpa, allowedVpas: [configuredVpa] }).ok;
        if (!paymentStatusOk(body.status).ok || !payeeVerified) {
          // A secret alone is not proof of a successful payment to this wallet.
          // Existing UTR claims remain pending for the admin to review.
          const pending = Object.values(wDb.config?.topupRequests || {}).find(r => r?.utr === validUtr.utr && r?.status === TOPUP_STATUS.PENDING);
          if (pending) notifyPendingTopup(bot.telegram, pending.id).catch(() => {});
          return replyJson(422, { ok: false, error: 'Payment status or recipient could not be verified; review pending claim.' });
        }

        // (a) Order ki fee — held QR (naya plan) ya deferred fee, dono settle.
        if (order && (Number(order.feeDeferredPaise || 0) > 0 || isOrderQrHeld(order) || Number(order.feeDuePaise || 0) > 0)) {
          const due = Number(order.feeDeferredPaise || order.feeDuePaise || feePaiseNow());
          if (!(amountPaise >= due)) {
            return replyJson(400, { ok: false, error: `Amount kam hai: due ₹${walletRupees(due)}` });
          }
          const owner = walletOwnerId(order);
          if (!owner || (body.userId && String(body.userId) !== owner) || (body.user_id && String(body.user_id) !== owner)) {
            return replyJson(409, { ok: false, error: 'Order owner does not match payment.' });
          }
          if (findUsedUtr(wDb, validUtr.utr)) return replyJson(409, { ok: false, error: 'UTR already used.' });
          const used = markUtrUsed(wDb, validUtr.utr, { userId: owner, amountPaise, status: 'CREDITED', source: 'order-fee-webhook' });
          if (used) used.orderId = orderId;
          // Fee charged mark (QR held tha) + deferred due clear — dono ek saath.
          order.feeChargedPaise = Number(order.feeChargedPaise || 0) + due;
          order.feeChargedAt = new Date().toISOString();
          order.feeChargedVia = 'webhook-auto-verify';
          order.feeDeferredPaise = 0;
          order.feeDuePaise = 0;
          const settled = { ok: true, feePaise: due };
          wDb.orders[orderId] = order;
          if (!saveDbDurable(wDb)) return replyJson(503, { ok: false, error: 'Fee record could not be saved.' });
          backupMoneyNow().catch(() => {});
          const chatId = order.userChatId || order.userId;
          if (chatId) {
            await bot.telegram.sendMessage(
              chatId,
              '✅ <b>Payment confirm ho gaya</b> — aapko kuch karne ki zaroorat nahi.',
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          // 🧊 Fee auto-verify hui → held ORDER QR release (boss ka naya plan).
          await releaseHeldQrToCustomer(orderId, { reason: 'webhook auto-verify' }).catch(() => {});
          for (const bossId of [...new Set((wDb.config?.bossIds || []).map(String).filter(Boolean))]) {
            await bot.telegram.sendMessage(
              bossId,
              `🤖 <b>AUTO-VERIFIED</b> (webhook)\nOrder <code>#${escapeHtml(orderId)}</code> · ` +
              `fee ₹${walletRupees(settled.feePaise || due)}${utr ? ` · UTR <code>${escapeHtml(utr)}</code>` : ''}`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          return replyJson(200, { ok: true, settled: settled.feePaise || due, orderId });
        }

        // (b) A trusted, successful incoming payment may settle the matching
        // pending claim, or create one. A used UTR never creates a second credit.
        if (/^\d{1,20}$/.test(userId) && userId !== '0') {
          const used = findUsedUtr(wDb, validUtr.utr);
          const existing = Object.values(wDb.config?.topupRequests || {}).find((r) => r?.utr === validUtr.utr);
          if (used && (!existing || existing.status !== TOPUP_STATUS.PENDING || String(existing.userId) !== userId || String(used.status || '').toUpperCase() === 'CREDITED')) {
            return replyJson(409, { ok: false, error: 'UTR already used.' });
          }
          let request = existing;
          if (!request) {
            const created = submitTopupRequestWithLookup(wDb, {
              userId, utr: validUtr.utr, amountPaise, name: walletNameOf(userId),
              note: 'webhook auto-verify', autoVerify: false, minPaise: 100
            });
            if (!created.ok) return replyJson(409, { ok: false, error: created.reason || created.code });
            request = created.request;
          }
          if (request.status !== TOPUP_STATUS.PENDING || String(request.userId) !== userId) {
            return replyJson(409, { ok: false, error: 'UTR already used.' });
          }
          const approved = approveTopupRequest(wDb, request.id, { actor: 'webhook', approvedPaise: amountPaise, note: 'verified webhook' });
          if (!approved.ok) return replyJson(409, { ok: false, error: approved.code });
          recordStatementPayment(wDb, {
            utr: validUtr.utr, amountPaise, payeeName, payeeVpa,
            status: 'SUCCESS', at: Date.now(), source: 'webhook', ref: String(body.ref || '')
          }, { actor: 'webhook' });
          if (!saveDbDurable(wDb)) return replyJson(503, { ok: false, error: 'Wallet credit not saved.' });
          backupMoneyNow().catch(() => {});
          await bot.telegram.sendMessage(userId,
            `✅ ₹${walletRupees(amountPaise)} wallet me added.`, { parse_mode: 'HTML' }).catch(() => {});
          await resumeOrderAfterTopup(userId).catch(() => null);
          return replyJson(200, { ok: true, credited: amountPaise, userId });
        }
        return replyJson(200, { ok: false, error: 'orderId ya userId+amountPaise chahiye' });
      }

      // Live & Delivered Zero-Login Swiggy Order Tracking JSON Endpoint (`/api/track/:orderId?sig=...`)
      const apiTrackMatch = reqUrl.pathname.match(/^\/api\/track\/([A-Za-z0-9_-]+)$/);
      if (apiTrackMatch) {
        const orderId = apiTrackMatch[1];
        const sig = reqUrl.searchParams.get('sig') || '';
        if (sig !== computeTrackHmac(orderId)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: 'Unauthorized tracking signature' }));
        }
        const resolved = await resolveTrackEndpointPayload(orderId, {
          db: getDb(),
          onLiveDiscovery: async (ord, database) => {
            const firstBossChatId = database.config?.bossIds?.[0] || Number(process.env.BOSS_ID || 0);
            if (firstBossChatId) {
              await sendOrderDeliveryInfoNotice(bot.telegram, firstBossChatId, ord);
            }
          }
        });
        if (!resolved.ok) {
          res.writeHead(resolved.statusCode || 404, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, error: resolved.error || 'Order not found' }));
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(JSON.stringify(resolved.payload));
      }

      // Live & Delivered Zero-Login Shareable Swiggy Order Tracking Web Page (`/track/:orderId?sig=...`)
      const pageTrackMatch = reqUrl.pathname.match(/^\/track\/([A-Za-z0-9_-]+)$/);
      if (pageTrackMatch) {
        const orderId = pageTrackMatch[1];
        const sig = reqUrl.searchParams.get('sig') || '';
        if (sig !== computeTrackHmac(orderId)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Invalid or unauthorized live tracking link.');
        }
        const safeOrderId = JSON.stringify(orderId);
        const safeSig = JSON.stringify(sig);
        const trackHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Swiggy Order • #${escapeHtml(orderId)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  body{background:#0f172a;color:#f8fafc;min-height:100vh;padding:14px}
  .wrap{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:18px;padding:16px;box-shadow:0 12px 30px rgba(0,0,0,.35)}
  .badge{display:inline-flex;align-items:center;gap:6px;background:rgba(16,185,129,.16);color:#34d399;padding:5px 11px;border-radius:999px;font-size:12px;font-weight:700}
  .badge.cancel{background:rgba(239,68,68,.18);color:#f87171}
  .status{font-size:22px;font-weight:800;margin-top:10px;color:#fff}
  .sub{font-size:13px;color:#94a3b8;margin-top:4px}
  #map{width:100%;height:240px;border-radius:14px;overflow:hidden;background:#0b1220}
  .row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid rgba(148,163,184,.14);font-size:14px}
  .row:last-child{border-bottom:none}
  .row .val{text-align:right;word-break:break-word;max-width:68%}
  .muted{color:#94a3b8;font-size:13px;flex-shrink:0}
  .otpbox{display:inline-block;background:rgba(252,128,25,.16);border:1px solid rgba(252,128,25,.5);color:#fb923c;padding:4px 10px;border-radius:8px;font-weight:800;letter-spacing:2px;font-size:15px}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:13px 16px;border-radius:12px;background:#fc8019;color:#fff;text-decoration:none;font-weight:800;font-size:15px}
  .callbtn{padding:7px 13px;border-radius:10px;background:#10b981;color:#fff;text-decoration:none;font-weight:700;font-size:13px}
  .sec-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;margin-bottom:6px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span class="badge" id="badge">● ORDER STATUS · SWIGGY</span>
      <span class="muted" id="eta">Syncing...</span>
    </div>
    <div class="status" id="st">Fetching order details...</div>
    <div class="sub" id="sub">Verified directly from Swiggy order data.</div>
  </div>
  <div class="card" style="padding:10px" id="mapCard"><div id="map"></div></div>
  <div class="card" id="riderCard" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div class="muted">Delivery Partner</div>
        <div style="font-size:17px;font-weight:800;margin-top:2px" id="riderName">-</div>
      </div>
      <a class="callbtn" id="riderCall" href="#" style="display:none">☎ Call Rider</a>
    </div>
  </div>
  <div class="card" id="itemsCard" style="display:none">
    <div class="sec-title">Ordered Items</div>
    <div id="itemsList"></div>
  </div>
  <div class="card">
    <div class="sec-title">Order Summary</div>
    <div class="row"><span class="muted">Restaurant</span><strong class="val" id="rest">-</strong></div>
    <div class="row"><span class="muted">Swiggy Order ID</span><code class="val" id="soid">-</code></div>
    <div class="row" id="otpRow" style="display:none"><span class="muted">Delivery OTP</span><span class="otpbox" id="otpVal">-</span></div>
    <div class="row"><span class="muted">Order For</span><strong class="val" id="cust">-</strong></div>
    <div class="row" id="addrRow" style="display:none"><span class="muted">Deliver To</span><span class="val" id="addrVal">-</span></div>
    <div class="row" id="timeRow" style="display:none"><span class="muted">Order Time</span><span class="val" id="timeVal">-</span></div>
    <div class="row"><span class="muted">Paid Amount</span><strong class="val" id="amt">-</strong></div>
  </div>
  <a class="btn" id="swLink" href="#" target="_blank" rel="noopener" style="display:none">↗ Open official Swiggy tracking</a>
</div>
<script>
const OID = ${safeOrderId}, SIG = ${safeSig};
let map, riderMarker, destMarker, restMarker, routeLine, pollTimer = null;
async function refresh() {
  try {
    const r = await fetch('/api/track/' + encodeURIComponent(OID) + '?sig=' + encodeURIComponent(SIG));
    const d = await r.json();
    if (!d.ok) {
      document.getElementById('st').textContent = d.error || 'Order not found';
      return;
    }
    const badge = document.getElementById('badge');
    if (d.isCancelled) {
      badge.className = 'badge cancel';
      badge.textContent = '× ORDER CANCELLED';
    } else if (d.isDelivered) {
      badge.className = 'badge';
      badge.textContent = '✓ DELIVERED · SWIGGY VERIFIED';
    } else {
      badge.className = 'badge';
      badge.textContent = '● LIVE ORDER · SWIGGY';
    }
    document.getElementById('st').textContent = d.orderStatus || 'Order Confirmed';
    document.getElementById('sub').textContent = d.statusSubText || (d.orderTime ? ('Ordered: ' + d.orderTime) : ('Synced: ' + new Date().toLocaleTimeString()));
    document.getElementById('eta').textContent = d.isDelivered ? '✓ Delivered' : (d.isCancelled ? 'Cancelled' : (d.etaMinutes ? ('◷ ' + d.etaMinutes + ' mins') : 'Live'));
    document.getElementById('rest').textContent = d.restaurantAddress ? (d.restaurantName + ' · ' + d.restaurantAddress) : (d.restaurantName || '-');
    document.getElementById('soid').textContent = d.swiggyOrderId || OID;
    document.getElementById('cust').textContent = d.customerName || '-';
    document.getElementById('amt').textContent = d.finalPayable ? ('₹' + d.finalPayable) : '₹0';
    if (d.deliveryOtp) {
      document.getElementById('otpRow').style.display = 'flex';
      document.getElementById('otpVal').textContent = d.deliveryOtp;
    }
    const addrText = d.deliveryAddress && (d.deliveryAddress.address || d.deliveryAddress.area || d.deliveryAddress.city);
    if (addrText) {
      document.getElementById('addrRow').style.display = 'flex';
      document.getElementById('addrVal').textContent = addrText;
    }
    if (d.orderTime) {
      document.getElementById('timeRow').style.display = 'flex';
      document.getElementById('timeVal').textContent = d.orderTime;
    }
    if (Array.isArray(d.items) && d.items.length > 0) {
      const itemsCard = document.getElementById('itemsCard');
      const itemsList = document.getElementById('itemsList');
      itemsCard.style.display = 'block';
      itemsList.innerHTML = '';
      d.items.forEach(function(it) {
        const row = document.createElement('div');
        row.className = 'row';
        const left = document.createElement('span');
        left.textContent = (it.name || 'Item') + (it.qty > 1 ? (' × ' + it.qty) : '');
        const right = document.createElement('strong');
        right.textContent = it.price ? ('₹' + it.price) : ('×' + (it.qty || 1));
        row.appendChild(left);
        row.appendChild(right);
        itemsList.appendChild(row);
      });
    }
    const swLink = document.getElementById('swLink');
    if (d.swiggyWebTrackUrl) {
      swLink.href = d.swiggyWebTrackUrl;
      swLink.textContent = '↗ Open official Swiggy tracking';
      swLink.style.display = 'flex';
    } else {
      swLink.style.display = 'none';
    }
    if (d.deliveryBoy && d.deliveryBoy.name) {
      document.getElementById('riderCard').style.display = 'block';
      document.getElementById('riderName').textContent = '↗ ' + d.deliveryBoy.name;
      if (d.deliveryBoy.mobile) {
        const cb = document.getElementById('riderCall');
        cb.style.display = 'inline-block';
        cb.href = 'tel:' + d.deliveryBoy.mobile;
      }
    }
    const dLat = parseFloat(d.deliveryAddress && d.deliveryAddress.lat), dLng = parseFloat(d.deliveryAddress && d.deliveryAddress.lng);
    const rLat = parseFloat(d.deliveryBoy && d.deliveryBoy.lat), rLng = parseFloat(d.deliveryBoy && d.deliveryBoy.lng);
    const sLat = parseFloat(d.restaurantLat), sLng = parseFloat(d.restaurantLng);
    const cLat = !isNaN(rLat) ? rLat : (!isNaN(dLat) ? dLat : (!isNaN(sLat) ? sLat : 26.8658));
    const cLng = !isNaN(rLng) ? rLng : (!isNaN(dLng) ? dLng : (!isNaN(sLng) ? sLng : 80.9307));
    if (!map && window.L) {
      map = L.map('map').setView([cLat, cLng], 14);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
    }
    const bounds = [];
    if (map && !isNaN(sLat) && !isNaN(sLng)) {
      bounds.push([sLat, sLng]);
      if (!restMarker) restMarker = L.marker([sLat, sLng]).addTo(map).bindPopup('🍽 ' + (d.restaurantName || 'Restaurant'));
      else restMarker.setLatLng([sLat, sLng]);
    }
    if (map && !isNaN(dLat) && !isNaN(dLng)) {
      bounds.push([dLat, dLng]);
      if (!destMarker) destMarker = L.marker([dLat, dLng]).addTo(map).bindPopup('⌖ Delivery Address');
      else destMarker.setLatLng([dLat, dLng]);
    }
    if (map && !isNaN(sLat) && !isNaN(sLng) && !isNaN(dLat) && !isNaN(dLng)) {
      if (!routeLine) routeLine = L.polyline([[sLat, sLng], [dLat, dLng]], { color: '#fc8019', weight: 3, dashArray: '7,7' }).addTo(map);
      else routeLine.setLatLngs([[sLat, sLng], [dLat, dLng]]);
    }
    if (map && !isNaN(rLat) && !isNaN(rLng)) {
      bounds.push([rLat, rLng]);
      if (!riderMarker) riderMarker = L.marker([rLat, rLng]).addTo(map).bindPopup('↗ Delivery Partner (Live)').openPopup();
      else riderMarker.setLatLng([rLat, rLng]);
      map.setView([rLat, rLng], 15);
    } else if (map && bounds.length >= 2) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
    } else if (map && bounds.length === 1) {
      map.setView(bounds[0], 15);
    }
    if ((d.isDelivered || d.isCancelled) && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (e) {}
}
refresh();
pollTimer = setInterval(refresh, 8000);
</script>
</body>
</html>`;
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate'
        });
        return res.end(trackHtml);
      }

    } catch (e) {}

    const liveAccounts = Object.values(getDb().config?.accounts || {}).filter(a => a?.isLoggedIn);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: botRuntimeState.launched ? 'ok' : 'starting',
      bot: botRuntimeState.launched ? 'online' : 'not-running',
      build: 'telegram-button-order-flow',
      launched: botRuntimeState.launched,
      launchTime: botRuntimeState.launchedAt,
      bootError: botRuntimeState.bootError,
      ipv4Shield: true,
      zeroSmsShield: true,
      zeroChromiumOrderFlow: true,
      tenOrderParallelAutoDispatch: true,
      zeroOtpCartIntake: true,
      cloudAccountVault: true,
      activeVaultAccounts: liveAccounts.length,
      perf: perfSnapshot({
        db: getDbIoStats(),
        updates: typeof getUpdateRuntimeStats === 'function' ? getUpdateRuntimeStats() : null,
        payment: getPaymentPollerStats()
      }),
      timestamp: new Date().toISOString()
    }));
  });
  server.listen(healthPort, '0.0.0.0', () => {
    console.log(`◎ Cloud health & Swiggy tracking server listening on 0.0.0.0:${healthPort}`);
  });

  // ── PERFORMANCE GUARDS ───────────────────────────────────────────────────
  // Ek hi line ka honest warning Boss ko, sirf jab sach me memory pressure ho.
  startMemoryGuard({
    onPressure: () => { try { pruneDbForPerformance(); } catch {} },
    onCritical: ({ heapMb, usedPct }) => {
      const db = getDb();
      const bossId = Number((db.config?.bossIds || [])[0] || process.env.BOSS_ID || 0);
      if (!bossId) return;
      telegram.sendMessage(
        bossId,
        `⚠️ <b>System memory pressure</b>\n\n` +
        `◈ Heap: <b>${heapMb}MB (${usedPct}%)</b>\n` +
        `◈ DB prun&#8203;e + cache clean kar diya (purane band orders ka bhaari data hata).\n\n` +
        `<i>Bot chal raha hai — lekin agar ye baar-baar aaye to Render ka plan upgrade karna padega.</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  });

  // 30 min par DB hygiene (boot par bhi ek baar)
  const runHygiene = () => {
    try {
      const out = pruneDbForPerformance();
      if (out.stripped || out.removed) {
        logThrottled('db-hygiene', `◈ DB hygiene: ${out.removed} purane order hataye, ${out.stripped} bhaari field saaf kiye (memory free).`);
      }
    } catch {}
  };
  runHygiene();
  const hygieneTimer = setInterval(runHygiene, 30 * 60 * 1000);
  if (typeof hygieneTimer.unref === 'function') hygieneTimer.unref();

  // Self keep-alive ping every 8 minutes via public Render edge URL so container never idles out
  const keepAliveUrl = getPublicServiceBaseUrl() + '/';
  setInterval(() => {
    fetch(keepAliveUrl, { signal: AbortSignal.timeout(10000) })
      .then(r => logThrottled('keepalive', `♥ Keep-alive ping -> ${keepAliveUrl} [${r.status}]`))
      .catch(e => logThrottled('keepalive-fail', `♥ Keep-alive retry note: ${e.message}`));
  }, 8 * 60 * 1000).unref();
}

// ── BOUNDED CONCURRENT UPDATE DISPATCHER ────────────────────────────────────
// Telegraf ka polling loop ek-ek update await karta hai: Account #1 ke Swiggy
// call ke peeche #2/#3 atak jaate hain. Isliye concurrent dispatch chahiye —
// par BILA limit ke nahi! Pehle har update turant parallel chalta tha, to 10
// order aane par 10+ bhaari handler ek saath chalte the aur Render instance ki
// memory/CPU khatam ho jaati thi ("hawa nikal jaati hai"). Ab:
//   • max N updates parallel (UPDATE_CONCURRENCY, default 6)
//   • baaki ek queue me (UPDATE_QUEUE_MAX, default 300)
//   • har update par deadline (UPDATE_DEADLINE_MS, default 45s) — atka handler
//     slot release kar deta hai, queue aage badhti hai
//   • ek hi update_id dobara aaye (Telegram retry) to duplicate skip
const updateRuntime = {
  active: 0,
  peak: 0,
  queued: 0,
  completed: 0,
  dropped: 0,
  timeouts: 0,
  duplicates: 0,
  seenIds: new Map(),
  queue: [],
  maxConcurrency: Math.max(1, Math.min(32, Number(process.env.UPDATE_CONCURRENCY) || 6)),
  deadlineMs: Math.max(10_000, Number(process.env.UPDATE_DEADLINE_MS) || 45_000),
  queueMax: Math.max(20, Number(process.env.UPDATE_QUEUE_MAX) || 300)
};

function isDuplicateUpdate(update) {
  const id = update?.update_id;
  if (!id) return false;
  const now = Date.now();
  const seen = updateRuntime.seenIds;
  for (const [k, at] of seen) if (now - at > 120_000) seen.delete(k);
  if (seen.has(id)) {
    updateRuntime.duplicates += 1;
    return true;
  }
  seen.set(id, now);
  return false;
}

function pumpUpdateQueue(rawHandleUpdate) {
  while (updateRuntime.active < updateRuntime.maxConcurrency && updateRuntime.queue.length > 0) {
    const job = updateRuntime.queue.shift();
    updateRuntime.queued = updateRuntime.queue.length;
    updateRuntime.active += 1;
    updateRuntime.peak = Math.max(updateRuntime.peak, updateRuntime.active);

    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), updateRuntime.deadlineMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    const work = Promise.resolve()
      .then(() => rawHandleUpdate(job.update, job.webhookResponse))
      .catch((err) => console.error('[UpdateDispatcher] handler failed:', err?.message || err));

    Promise.race([work, deadline])
      .then((outcome) => {
        if (outcome === 'timeout') {
          updateRuntime.timeouts += 1;
          const kind = job.update?.callback_query ? 'button' : (job.update?.message ? 'message' : 'update');
          console.warn(`[UpdateDispatcher] ${kind} ${updateRuntime.deadlineMs / 1000}s me poora nahi hua — slot chhoda (kaam background me chal raha hai).`);
        }
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        updateRuntime.active = Math.max(0, updateRuntime.active - 1);
        updateRuntime.completed += 1;
        pumpUpdateQueue(rawHandleUpdate);
      });
  }
}

const rawBotHandleUpdate = bot.handleUpdate.bind(bot);
bot.handleUpdate = (update, webhookResponse) => {
  if (isDuplicateUpdate(update)) return Promise.resolve();
  if (updateRuntime.queue.length >= updateRuntime.queueMax) {
    updateRuntime.dropped += 1;
    console.warn('[UpdateDispatcher] queue full — update drop kiya (bot phir bhi jawab dega, dobara tap karein).');
    return Promise.resolve();
  }
  updateRuntime.queue.push({ update, webhookResponse });
  updateRuntime.queued = updateRuntime.queue.length;
  pumpUpdateQueue(rawBotHandleUpdate);
  return Promise.resolve();
};

export function getUpdateRuntimeStats() {
  return {
    active: updateRuntime.active,
    peak: updateRuntime.peak,
    queued: updateRuntime.queued,
    completed: updateRuntime.completed,
    dropped: updateRuntime.dropped,
    timeouts: updateRuntime.timeouts,
    duplicates: updateRuntime.duplicates,
    maxConcurrency: updateRuntime.maxConcurrency,
    deadlineMs: updateRuntime.deadlineMs
  };
}

bot.command('parallel', async (ctx) => {
  if (!isBoss(ctx.from.id)) return;
  try {
    const out = await dispatchAllReadyOrdersInParallel({
      telegram: ctx.telegram,
      chatId: ctx.chat.id,
      formatOrderBodyFn: formatUserOrderCardText
    });
    if (out.dispatched === 0) {
      return ctx.reply(`i ${out.reason}`, { parse_mode: 'HTML' });
    }
    const okCount = out.settled.filter(s => s.status === 'fulfilled').length;
    await ctx.reply(
      `! <b>Parallel Multi-ID Sync Complete:</b> <b>${okCount}/${out.dispatched}</b> ready order(s) fetched simultaneously on separate Swiggy IDs!`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    const diag = formatBossDiagnosticErrorMessage(err, { stage: 'COMMAND_PARALLEL' });
    await ctx.reply(diag, { parse_mode: 'HTML' });
  }
});

let autoEventPrebookTimer = null;
function startAutoEventOffersPrebookLoop() {
  if (autoEventPrebookTimer) return;
  const runSweep = async () => {
    try {
      const db = getDb();
      const entries = Object.entries(db?.config?.accounts || {}).filter(([, a]) => a?.isLoggedIn && (a.cookies || a.tid || a.token));
      if (entries.length === 0) return;
      const CLAIM_BATCH_SIZE = 2;
      for (let b = 0; b < entries.length; b += CLAIM_BATCH_SIZE) {
        const chunk = entries.slice(b, b + CLAIM_BATCH_SIZE);
        await Promise.all(
          chunk.map(async ([, acc]) => {
            // Chaaron offers (Late Night, Breakfast, Extra ₹50, Weekend) —
            // pehle sirf do claim hote the.
            const out = await autoActivateEventOffers(acc, {
              force: true,
              offerValue: acc.preferredOfferValue || 1
            }).catch(() => null);
            if (out) {
              acc.offers = out.offers || out;
              acc.hasBreakfast = Boolean(out.breakfast?.status === 'CLAIMED');
              acc.hasLateNight = Boolean(out.lateNight?.status === 'CLAIMED');
              acc.hasExtra50 = Boolean(out.extra50?.status === 'CLAIMED');
              acc.hasWeekend = Boolean(out.weekend?.status === 'CLAIMED');
            }
          })
        );
        if (b + CLAIM_BATCH_SIZE < entries.length) {
          await new Promise(r => setTimeout(r, 350));
        }
      }
      saveDb(db);
      console.log(`▣ [AutoPreBook] Locked Breakfast + Late Night offers across 15 days for ${entries.length} account(s)!`);
    } catch (e) {
      console.warn('[AutoPreBook] Sweep warning:', e.message);
    }
  };
  const bootKick = setTimeout(runSweep, 2500);
  if (typeof bootKick.unref === 'function') bootKick.unref();
  // Run every 2 hours so every account is ALWAYS pre-booked well before both 05:00 AM IST & 06:30 PM IST cutoffs!
  autoEventPrebookTimer = setInterval(runSweep, 2 * 60 * 60 * 1000);
  if (typeof autoEventPrebookTimer.unref === 'function') autoEventPrebookTimer.unref();
}

// The private-chat menu is separate from the native Main Mini App buttons in
// the profile/chat list, which the bot owner must enable in @BotFather.
// Never overwrite a manually configured Telegram menu when no valid URL is set.
export async function configureTelegramBotMenu(telegram, rawUrl = process.env.PRO_MINIAPP_URL) {
  const miniAppUrl = configuredMiniAppUrl(rawUrl);
  let ok = true;
  try {
    await telegram.setMyCommands([
      { command: 'start', description: 'Start a new Swiggy order' },
      ...(miniAppUrl ? [{ command: 'pro', description: 'Open the Mini App' }] : []),
      { command: 'help', description: 'How to place an order' },
      { command: 'cancel', description: 'Cancel the current draft order' }
    ]);
  } catch (e) {
    ok = false;
    console.warn('[Menu] setMyCommands skipped:', e?.message || e);
  }
  if (miniAppUrl) {
    try {
      await telegram.setChatMenuButton({
        menuButton: { type: 'web_app', text: 'Open', web_app: { url: miniAppUrl } }
      });
    } catch (e) {
      ok = false;
      console.warn('[Menu] setChatMenuButton skipped:', e?.message || e);
    }
  }
  return ok;
}

let botMenuReady = false;
let botMenuSetupPromise = null;
function setupBotMenu() {
  if (botMenuReady) return Promise.resolve(true);
  if (!botMenuSetupPromise) {
    botMenuSetupPromise = configureTelegramBotMenu(bot.telegram)
      .then(ok => { botMenuReady = ok; return ok; })
      .finally(() => { botMenuSetupPromise = null; });
  }
  return botMenuSetupPromise;
}

// Launch bot with retry resilience for cloud container handover
// 💳 Payment UPI: env se seed karo (agar panel me kuch set nahi hai), taaki
// order QR fallback aur ₹ verification dono ek hi UPI par jaayein.
try {
  const bootUpiDb = getDb();
  const envUpi = String(process.env.BOSS_UPI_ID || process.env.UPI_ID || '').trim();
  if (!String(bootUpiDb.config?.bossUpiId || '').trim() && envUpi && isValidUpiVpa(envUpi) && !isPlaceholderUpiId(envUpi)) {
    bootUpiDb.config.bossUpiId = envUpi;
    bootUpiDb.config.bossUpiSeededFromEnv = true;
    saveDb(bootUpiDb);
    console.log('› Payment UPI (env se seed):', envUpi);
  }
} catch {}

console.log('› Connecting to Telegram Bot API...');
// A bad/revoked token will never fix itself — retrying makes no sense.
export function isFatalTelegramAuthError(err) {
  const text = `${err?.message || ''} ${err?.description || ''} ${err?.code || ''} ${err?.response?.error_code || ''}`;
  return /\b(401|404)\b/.test(text) || /Unauthorized|Not Found|invalid token/i.test(text);
}

const BOOT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];

async function startBotWithRetry() {
  let launched = false;
  try {
    // Restore ALL saved `.json` accounts from Persistent Cloud Vault BEFORE serving orders!
    await hydrateAccountsFromCloudVault().catch(e => console.warn('CloudVault boot warning:', e.message));
    // Boss (31-10-2026, round 19): "deploy karne par sara data reset ho jata
    // hai" — wallet aur UTR ledger disk par the, deploy par ud jaate the.
    // Ab boot par cloud snapshot se paisa/UTR wapas, aur 30s me snapshot chalta
    // rehta hai. Paisa kabhi kam nahi hota (merge max balance leta hai).
    // Round 22 (boss): "JITNE BHI LOGIN ID HOTE HAIN KISKA DATA NAHI BACHTA".
    // Deploy ke baad khaali db me login IDs + mini-app workspaces wapas — money
    // snapshot se pehle, kyunki IDs ke bina paisa bhi bekaar hai.
    try {
      const identity = await restoreIdentityOnBoot();
      if (identity?.restored) console.log(`[db-durability] login ID restore hua (${identity.source})`, JSON.stringify(identity.summary || {}));
    } catch (err) { console.warn('[db-durability] identity restore warning:', err?.message || err); }
    try {
      const money = await restoreMoneyOnBoot();
      if (money?.restored) console.log(`[db-durability] paisa/UTR restore hua (${money.source})`, JSON.stringify(money.summary || {}));
    } catch (err) { console.warn('[db-durability] restore warning:', err?.message || err); }
    // Round 26 (boss: "PHIR DEPLOY HOTE HI SAB ERASE HOGAYA"): boot par hi
    // asli jaanch — vault padha ja raha hai ya nahi. Jhootha "sab theek" nahi.
    try {
      const doctor = await runDurabilityDoctor({ skipWriteTest: true });
      if (doctor.canRestore) console.log(`[durability-doctor] vault se restore possible — ${doctor.verdictLine}`);
      else console.warn(`[durability-doctor] ⚠ RESTORE NAHI HO SAKTA — ${doctor.verdictLine} | failed: ${doctor.failed.join(',')} | next: ${doctor.nextStep.join(' | ')}`);
    } catch (err) { console.warn('[durability-doctor] check fail:', err?.message || err); }
    startDbDurability();
    // Rehydrate the shared WAF token + breaker state (the vault hydrate above
    // may have written a newer token into db.waf).
    wafPool.loadFromDb();

    // If getMe() throws once (Telegram hiccup, DNS blip) the old code logged it and
    // returned — the process then exited 0 and the platform marked the deploy
    // healthy while the bot was dead. Retry, then fail loudly.
    let me = null;
    for (let attempt = 0; attempt <= BOOT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        me = await bot.telegram.getMe();
        break;
      } catch (err) {
        if (isFatalTelegramAuthError(err)) {
          console.error('× Telegram rejected BOT_TOKEN — check the token in the environment:', err.message);
          process.exit(1);
        }
        if (attempt === BOOT_RETRY_DELAYS_MS.length) throw err;
        const wait = BOOT_RETRY_DELAYS_MS[attempt];
        console.warn(`◷ Telegram getMe failed (${err.message}) — retry ${attempt + 1}/${BOOT_RETRY_DELAYS_MS.length} in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    console.log(`⚙ Logged in as @${me.username} (${me.first_name}) [ID: ${me.id}]`);

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        console.log('⚙ Telegram Swiggy Real OTP Flow Bot is running live!');
        const retryPendingNotices = () => {
          retryPendingTopupNotifications(bot.telegram).catch(() => {});
          retryPendingWalletUtrs({ telegram: bot.telegram }).catch(() => {});
        };
        setTimeout(retryPendingNotices, 5000).unref?.();
        setInterval(retryPendingNotices, 60_000).unref?.();
        startWafKeepWarmLoop();
        startAutoEventOffersPrebookLoop();
        // 🔐 Mini App vault: key khud manage hoti hai (boss 31-10-2026 —
        // "Server setup needed" ka dead-end hata). Owner ko sach batate hain.
        try {
          const vaultSource = getProVaultSource();
          if (vaultSource && vaultSource !== 'ENV') {
            console.log(`[MiniAppVault] source=${vaultSource} — Mini App apni stable key khud use kar raha hai.`);
            setTimeout(async () => {
              for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
                await bot.telegram.sendMessage(
                  bossId,
                  `🔐 <b>MINI APP STORAGE</b>\n` +
                  `Source: <code>${escapeHtml(vaultSource)}</code>\n\n` +
                  `<i>Mini App chal raha hai — koi setup zaroori nahi.\n` +
                  (vaultSource === 'DERIVED'
                    ? 'Key bot ke server secrets se banti hai, isliye redeploy ke baad bhi wahi rehti hai.'
                    : 'Key file disk par save hai.') +
                  `\nPura control chahiye to Render me <code>PRO_VAULT_KEY</code> (16+ chars) set kar do — <b>badalna mat</b>, warna purana mini-app data nahi khulega.</i>`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
            }, 12_000).unref?.();
          }
        } catch (vaultErr) {
          console.warn('[MiniAppVault] setup issue:', vaultErr?.message || vaultErr);
        }
        // 🩺 Maintenance loop: bot khud ko sambhalta rahe — atke locks,
        // purani reservations aur phansi scans har 60s me saaf.
        startMaintenanceLoop({ cart, tracking, db: getDb, saveDb }, {
          intervalMs: 60_000,
          onReport: async (report) => {
            const freed = (report.locksReleased?.length || 0) + (report.reservationsReleased?.length || 0) + (report.scansReset || 0);
            // Atka hua kaam (jaise QR generation budget se zyada) — chup-chaap
            // hang nahi, boss ko ek baar batata hai.
            const stuck = Array.isArray(report.newStuckJobs) ? report.newStuckJobs : [];
            if (stuck.length > 0) {
              for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
                await bot.telegram.sendMessage(
                  bossId,
                  `⏱ <b>ATKA HUA KAAM</b>\n` +
                  stuck.map((j) => `• <code>${escapeHtml(String(j.key))}</code> — ${Math.round(Number(j.ageMs || 0) / 1000)}s se chal raha hai (budget ${Math.round(Number(j.timeoutMs || 0) / 1000)}s)`).join('\n') +
                  `\n<i>Kaam roka nahi gaya — beech me rokna duplicate order bana sakta hai. Zyada der rahe to 🩺 Maintenance kholo.</i>`,
                  { parse_mode: 'HTML' }
                ).catch(() => {});
              }
            }
            if (freed <= 0) return;
            for (const bossId of [...new Set((getDb().config?.bossIds || []).map(String).filter(Boolean))]) {
              await bot.telegram.sendMessage(
                bossId,
                `🧹 <b>MAINTENANCE</b> — bot ne khud ${freed} atki cheez free ki:\n` +
                [
                  report.locksReleased?.length ? `• ${report.locksReleased.length} ID lock` : '',
                  report.reservationsReleased?.length ? `• ${report.reservationsReleased.length} ID reservation` : '',
                  report.scansReset ? `• ${report.scansReset} tracking scan` : ''
                ].filter(Boolean).join('\n'),
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          }
        });
        if (process.env.PREWARM_CHROME === 'true') {
          console.log('! Priming pre-warmed Chrome for instant OTP in background...');
          prewarmBrowser().catch(e => console.log('Prewarm init note:', e.message));
        }
        // Telegraf's polling launch does not resolve until polling stops. Start
        // menu setup without blocking polling rather than waiting until shutdown.
        setupBotMenu().catch(e => console.error('Menu setup error:', e.message));
        await bot.launch({ dropPendingUpdates: true });
        launched = true;
        botRuntimeState.launched = true;
        botRuntimeState.launchedAt = new Date().toISOString();
        resumeAutoTrackingForRecentOrders();
        break;
      } catch (err) {
        if ((err.message?.includes('409') || err.description?.includes('Conflict')) && attempt < 10) {
          console.log(`◷ [Attempt ${attempt}/10] Telegram 409 Conflict (previous cloud container shutting down). Retrying in 4 seconds...`);
          await new Promise(r => setTimeout(r, 4000));
        } else {
          console.error('× Launch error:', err.message);
          break;
        }
      }
    }
  } catch (err) {
    botRuntimeState.bootError = err?.message || String(err);
    console.error('× Failed to connect to Telegram:', err);
  }

  // Never exit 0 with a dead bot: a clean exit looks like a healthy deploy to the
  // host and nothing ever restarts it. A non-zero exit triggers a container restart.
  if (!launched) {
    console.error('× Bot never started polling — exiting with code 1 so the host restarts the container.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// AUTOMATIC TRACKING NOTIFIER
// ---------------------------------------------------------------------------
// Called by order-tracking.js the moment a genuine Swiggy share/tracking link
// is discovered. Everything below is best-effort and never throws upward.
async function pushTrackingReadyNotice(order, { scan } = {}) {
  if (!order) return;
  const url = getStoredSwiggyTrackingUrl(order);

  // Deliver customer live delivery milestone update (Heading to restaurant, Delivery partner name, Call partner, Swiggy order phone, OTP, Delivered):
  try {
    await pushCustomerLiveDeliveryMilestone(order, { scan });
  } catch (e) {
    console.warn('[pushCustomerLiveDeliveryMilestone] error:', e?.message || e);
  }

  // Update order cards in place so customer and boss card show latest status/rider/OTP:
  try { await updateOrderCards(order); } catch {}

  if (!url) return;
  const db = getDb();

  // SIMPLE MODE: the customer gets ONE short bubble with a tap-to-track button
  // instead of the long boss-style report. The boss report below is unchanged.
  const simpleCustomerOrder = isSimpleChatEnabled() && !isBoss(Number(order.userId || 0)) &&
    (order.simpleChat || order.isCustomerSubmitted);
  if (simpleCustomerOrder) {
    try { await sendSimpleTrackingOnce(order); } catch {}
  }
  const swiggyId = swiggyOrderIdOf(order);
  const phone = placedFromPhoneOf(order, db) || orderPlacedFromPhone(order, db);
  const restaurant = String(order.restaurantName || 'Swiggy Order').slice(0, 40);

  const lines = [
    `🔗 <b>Live Swiggy tracking ready</b>`,
    '',
    `▪ <b>Swiggy order:</b> <code>${escapeHtml(swiggyId || '—')}</code>`,
    `▪ <b>Order ref:</b> <code>#${escapeHtml(String(order.id))}</code>`,
    `▪ <b>Placed from:</b> <code>${escapeHtml(phone || '—')}</code>`,
    `▪ <b>Restaurant:</b> ${escapeHtml(restaurant)}`,
  ];
  if (order.liveOrderStatus) lines.push(`▪ <b>Status:</b> <code>${escapeHtml(String(order.liveOrderStatus))}</code>`);
  if (order.deliveryOtp) lines.push(`▪ <b>Delivery OTP:</b> <code>${escapeHtml(String(order.deliveryOtp))}</code>`);
  lines.push('', `<a href="${escapeHtml(url)}">Open live Swiggy tracking</a>`);
  const text = lines.join('\n');

  // 1) Edit the customer's payment message in place (I-have-paid button gone).
  try { await tryEditCustomerPaymentMessageWithTracking(order); } catch {}

  // 2) Show it on the order cards.
  try { await updateOrderCards(order); } catch {}

  // 3) One Telegram message per chat (deduped by URL).
  const notified = (order.trackingNoticeSentTo && typeof order.trackingNoticeSentTo === 'object')
    ? { ...order.trackingNoticeSentTo }
    : {};
  const targets = new Set();
  for (const id of [order.userChatId, order.userId, order.fwdSenderUserId, order.bossChatId]) {
    if (id) targets.add(String(id));
  }
  for (const bossId of (Array.isArray(db.config?.bossIds) ? db.config.bossIds : [])) targets.add(String(bossId));
  const fallbackBoss = Number(process.env.BOSS_ID || 0);
  if (fallbackBoss) targets.add(String(fallbackBoss));

  const customerChatIds = new Set(
    [order.userChatId, order.userId, order.fwdSenderUserId]
      .filter(Boolean)
      .map(String)
  );
  for (const chatId of targets) {
    if (!chatId || notified[chatId] === url) continue;
    // Simple-mode customers already got their own short tracking bubble.
    if (simpleCustomerOrder && customerChatIds.has(String(chatId))) {
      notified[chatId] = url;
      continue;
    }
    try {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard([[Markup.button.url('🔗 Open Swiggy tracking', url)]])
      });
      notified[chatId] = url;
    } catch {}
  }

  try {
    const fresh = getDb();
    if (fresh.orders?.[order.id]) {
      fresh.orders[order.id].trackingNoticeSentTo = notified;
      saveDb(fresh);
    }
  } catch {}

  // 4) Update the notice record; the bot does not send recipient SMS.
  try {
    const bossChat = order.bossChatId || db.config?.bossIds?.[0] || fallbackBoss;
    if (bossChat) await sendOrderDeliveryInfoNotice(bot.telegram, bossChat, order);
  } catch {}
}

setOrderTrackingNotifier(pushTrackingReadyNotice);
setOrderMilestoneNotifier(pushCustomerLiveDeliveryMilestone);

// After a restart, resume tracking for recent confirmed orders that still have
// no share link — "kal raat se tracking nahi mila" never needs a manual tap.
let activeTrackingSweepTimer = null;
let deliveredExportTimer = null;

function resumeAutoTrackingForRecentOrders() {
  try {
    const db = getDb();
    const since = Date.now() - 36 * 60 * 60 * 1000;
    const candidates = Object.values(db.orders || {})
      .filter(order => order && order.id && swiggyOrderIdOf(order) && !getStoredSwiggyTrackingUrl(order))
      .filter(order => ['COMPLETED', 'ACCEPTED'].includes(order.status))
      .filter(order => {
        const created = new Date(order.completedAt || order.createdAt || 0).getTime();
        return Number.isFinite(created) && created >= since;
      })
      .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0))
      .slice(0, 6);
    // Stagger the boot scans so recent orders never hammer Swiggy at once.
    // 2026-10-22: the old 4s stagger burst (6 orders × 29 IDs in ~20s, right
    // after a deploy) was a big part of what tripped Swiggy's WAF. 20s apart
    // keeps the same coverage without the burst.
    candidates.forEach((order, index) => {
      startOrderTrackingAuto(order.id, { budgetMs: 12000, deep: false, initialDelayMs: 10_000 + index * 20_000 });
    });
    if (candidates.length) console.log(`↻ Auto-tracking resumed for ${candidates.length} recent order(s).`);

    // Running orders (PENDING/ACCEPTED/bill/QR stages) also deserve their OFO
    // link — but this sweep is READ-ONLY: no logout, no session wipe, no account
    // removal. One pass after boot, then every 10 minutes while something is open.
    const activePending = listActiveOrdersNeedingTracking(db);
    if (activePending.length) {
      setTimeout(() => {
        refreshActiveOrdersTracking({ budgetMs: 12000, deep: false, concurrency: 4, limit: 8, maxAgeMs: 24 * 60 * 60 * 1000 })
          .then((out) => console.log(`↻ Active-order tracking sweep: ${out.found}/${out.scanned} link(s) found (IDs untouched).`))
          .catch((err) => console.warn('[ActiveTracking] boot sweep failed:', err?.message || err));
      }, 45_000).unref?.();
    }
    // Delivered-orders catch-up: if the milestone push was skipped (bot restart,
    // suppressed card, WAF hold) the auto export+logout must still happen.
    const runDeliveredExportSweep = () => {
      try {
        const liveDb = getDb();
        const pending = Object.values(liveDb.orders || {})
          .filter((o) => o && o.id && !o.autoExportDoneAt && isOrderDelivered(o))
          .filter((o) => {
            const made = new Date(o.deliveredAt || o.completedAt || o.createdAt || 0).getTime();
            return Number.isFinite(made) && made >= Date.now() - 48 * 60 * 60 * 1000;
          })
          .slice(0, 5);
        for (const o of pending) {
          autoExportDeliveredOrder(o.id).catch(() => {});
        }
        // 🔒 Terminal orders ke locks bhi saaf karo (bot restart ke baad bhi ID
        // vault me wapas aaye — koi ID hamesha ke liye atki na rahe).
        try { runAccountLockSweep(); } catch (err) { console.warn('[AccountLock] sweep failed:', err?.message || err); }
      } catch { /* never crash the bot */ }
    };
    setTimeout(runDeliveredExportSweep, 30_000).unref?.();
    if (!deliveredExportTimer) {
      const t = setInterval(runDeliveredExportSweep, 10 * 60 * 1000);
      if (typeof t.unref === 'function') t.unref();
      deliveredExportTimer = t;
    }

    if (!activeTrackingSweepTimer) {
      const timer = setInterval(() => {
        try {
          if (wafPool.cooldownRemainingMs() > 5000) return;
          if (listActiveOrdersNeedingTracking().length === 0) return;
          refreshActiveOrdersTracking({ budgetMs: 12000, deep: false, concurrency: 4, limit: 8, maxAgeMs: 24 * 60 * 60 * 1000 })
            .then((out) => {
              if (out.found) console.log(`↻ Active-order tracking sweep: ${out.found}/${out.scanned} link(s) found (IDs untouched).`);
            })
            .catch(() => {});
        } catch {}
      }, 10 * 60 * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      activeTrackingSweepTimer = timer;
    }

    // Catch-up for the old notifier race: orders where Swiggy's genuine link
    // WAS persisted by the scan but the "Live Swiggy tracking ready" push was
    // never delivered (e.g. order 251630299198497). Push it exactly once —
    // `pushTrackingReadyNotice` dedupes per chat by URL via trackingNoticeSentTo.
    const unannounced = Object.values(db.orders || {})
      .filter(order => order && order.id && swiggyOrderIdOf(order) && getStoredSwiggyTrackingUrl(order))
      .filter(order => ['COMPLETED', 'ACCEPTED'].includes(order.status))
      .filter(order => !isCancelledOrRefusedStatus(order.liveOrderStatus))
      .filter(order => {
        const created = new Date(order.completedAt || order.createdAt || 0).getTime();
        return Number.isFinite(created) && created >= since;
      })
      .sort((a, b) => new Date(b.completedAt || b.createdAt || 0) - new Date(a.completedAt || a.createdAt || 0))
      .slice(0, 6);
    unannounced.forEach((order, index) => {
      setTimeout(() => {
        pushTrackingReadyNotice(order).catch(() => {});
      }, 5000 + index * 4000);
    });
    if (unannounced.length) console.log(`↻ Tracking notice catch-up queued for ${unannounced.length} recent order(s).`);
  } catch (err) {
    console.warn('[order-tracking] resume failed:', err?.message || err);
  }
}

// ================= LAST-RESORT HANDLERS =================
// Registered last, so they only run when nothing above handled the update.
// Before this, an unknown/stale tap left the Telegram spinner running forever
// and a keyboard button with no handler did nothing at all.

bot.on('callback_query', async (ctx) => {
  const userId = ctx.from?.id;
  await ctx.answerCbQuery('Yeh button purana hai — screen refresh kar raha hoon.').catch(() => {});
  try {
    if (isBoss(userId)) {
      const home = getBossPanelHome();
      await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
      return;
    }
    if (userId) await renderUserCard(ctx, userId, { notice: '🟠 Yeh option ab available nahi' });
  } catch { /* a stale card must never crash the bot */ }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  try {
    if (isBoss(userId)) {
      const home = getBossPanelHome();
      await ctx.reply(home.text, { parse_mode: 'HTML', ...home.keyboard });
      return;
    }
    await renderUserCard(ctx, userId, { notice: '🟠 Cart link ya Delivery address link bhejein' });
  } catch { /* ignore */ }
});

// Exposed for the offline e2e suites (single-card chat behaviour).
export {
  bot,
  userWaitState,
  completeNewAccountWithChosenName,
  renderUserCard,
  cleanupUserChat,
  userChatCards,
  getUserScreen,
  updateOrderCards,
  promptForLink,
  resetCardAndAskForMissing,
  handleSendToBoss,
  ensureBossBillSummary,
  sendSimpleTrackingOnce,
  autoApproveConsentedSimpleOrder,
  startSimpleOrderFromDraft,
  getSimpleFocusOrder,
  customerOrderCard
};

if (!process.env.TEST_MODE && !process.env.BOT_TEST_MODE) {
  startBotWithRetry();
}

// `bot.stop()` throws when polling never started (bad token, boot failure) —
// swallow it so shutdown stays clean instead of surfacing as an uncaught throw.
process.once('SIGINT', () => {
  try { flushDbSync(); } catch {}
  try { bot.stop('SIGINT'); } catch {}
});
process.once('SIGTERM', () => {
  try { flushDbSync(); } catch {}
  try { bot.stop('SIGTERM'); } catch {}
});
