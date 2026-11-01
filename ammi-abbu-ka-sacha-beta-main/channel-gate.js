// ============================================================================
// channel-gate.js — Required Telegram channel gate (env default, admin-changeable)
// ============================================================================
// Boot default : env REQUIRED_CHANNEL (fallback @its_NoooB)
// Runtime      : boss runs /channel @name | /channel on | /channel off
//                stored in db.config.channelGate, no redeploy needed.
// Boss is always exempt. Verified members are cached 10 min, non-members 15 s,
// and concurrent lookups for the same user are merged into one API call.

import dotenv from 'dotenv';
import { isBoss, getDb, saveDb } from './store.js';

// channel-gate.js is evaluated before index.js runs dotenv.config(), so load it here.
dotenv.config();

export function normalizeChannelUsername(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^(t\.me|telegram\.me)\//i, '');
  s = s.replace(/^@/, '').replace(/\/+$/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(s)) return null;
  return '@' + s;
}

const channelUrlFor = (username) => `https://t.me/${username.replace(/^@/, '')}`;
const envDefaultChannel = () => normalizeChannelUsername(process.env.REQUIRED_CHANNEL) || '@its_NoooB';

export const REQUIRED_CHANNEL = envDefaultChannel();
export const REQUIRED_CHANNEL_URL = channelUrlFor(REQUIRED_CHANNEL);

// In-memory copy of the gate settings (getDb() parses db.json on every call).
let stateCache = null;

/** Current gate settings: { enabled, username, url }. */
export function getChannelGateState() {
  if (stateCache) return stateCache;
  const cfg = getDb().config?.channelGate || {};
  const username = normalizeChannelUsername(cfg.username) || envDefaultChannel();
  stateCache = { enabled: cfg.enabled !== false, username, url: channelUrlFor(username) };
  return stateCache;
}

/** Boss-only change. Throws Error('INVALID_CHANNEL') on a bad username. */
export function setChannelGate({ username, enabled } = {}) {
  const db = getDb();
  const cur = { ...(db.config?.channelGate || {}) };
  if (username !== undefined) {
    const n = normalizeChannelUsername(username);
    if (!n) throw new Error('INVALID_CHANNEL');
    cur.username = n;
  }
  if (enabled !== undefined) cur.enabled = Boolean(enabled);
  db.config = { ...(db.config || {}), channelGate: cur };
  saveDb(db);
  stateCache = null;
  memberCache.clear();
  inflight.clear();
  return getChannelGateState();
}

// userKey = `${channelUsername}|${userId}` so a channel change never serves stale results.
const memberCache = new Map(); // key -> { isMember, reason, expiresAt }
const inflight = new Map();    // key -> Promise
const CACHE_TTL_MS = 10 * 60 * 1000; // verified member
const NEG_TTL_MS = 15 * 1000;        // not a member: re-check quickly after joining

let testMockChecker = null;

/** Configure a mock checker for offline tests. */
export function setChannelGateMock(fn) {
  testMockChecker = typeof fn === 'function' ? fn : (fn === null ? null : () => Boolean(fn));
}

/** Clear cached verification for one user (all channels). */
export function clearChannelMemberCache(userId) {
  if (!userId) return;
  const suffix = '|' + String(userId);
  for (const k of memberCache.keys()) if (k.endsWith(suffix)) memberCache.delete(k);
}

/** Force-Join card, English only. */
export function formatChannelJoinCard(state = getChannelGateState()) {
  const text =
    `📢 <b>Join our channel to continue</b>\n\n` +
    `Please join <b>${state.username}</b> to use this bot.\n\n` +
    `After joining, tap <b>[ ✅ Check Joined ]</b> to unlock access.`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: `📢 Join ${state.username}`, url: state.url }],
        [{ text: '✅ Check Joined', callback_data: 'check_channel_joined' }]
      ]
    }
  };

  return { text, keyboard, channel: state.username };
}

/** Helper to detect the offline automated test suite. */
export function isTestRunner() {
  if (process.env.ENFORCE_CHANNEL_GATE === '1') return false;
  return process.argv.some(arg => /test_[^/\\]+\.mjs$/i.test(arg));
}

async function lookupMembership(telegram, idStr, state, key) {
  try {
    const member = await telegram.getChatMember(state.username, Number(idStr) || idStr);
    const validStatuses = ['creator', 'administrator', 'member', 'restricted'];
    const isMember = Boolean(member && validStatuses.includes(member.status));
    const result = { isMember, reason: isMember ? 'VERIFIED_MEMBER' : 'NOT_MEMBER' };
    memberCache.set(key, {
      ...result,
      expiresAt: Date.now() + (isMember ? CACHE_TTL_MS : NEG_TTL_MS)
    });
    return result;
  } catch (err) {
    const desc = String(err?.description || err?.message || '');
    if (/member list is inaccessible/i.test(desc)) {
      console.warn(`[ChannelGate] Bot must be an Administrator in ${state.username} to verify members.`);
      return { isMember: false, reason: 'ADMIN_REQUIRED' };
    }
    if (/user not found|PARTICIPANT_ID_INVALID|not a member|chat not found/i.test(desc)) {
      memberCache.set(key, { isMember: false, reason: 'NOT_FOUND', expiresAt: Date.now() + NEG_TTL_MS });
      return { isMember: false, reason: 'NOT_FOUND' };
    }
    console.warn(`[ChannelGate] Error verifying membership for user ${idStr}:`, desc);
    return { isMember: false, reason: 'API_ERROR' };
  }
}

/** Returns { isMember: boolean, reason: string }. */
export async function checkUserChannelMembership(telegram, userId, { bypassCache = false } = {}) {
  const idStr = String(userId || '');
  if (!idStr) return { isMember: false, reason: 'NO_USER_ID' };
  if (isBoss(idStr)) return { isMember: true, reason: 'BOSS_EXEMPT' };

  const state = getChannelGateState();
  if (!state.enabled) return { isMember: true, reason: 'GATE_OFF' };

  if (testMockChecker) {
    const res = await testMockChecker(idStr);
    return typeof res === 'object' ? res : { isMember: Boolean(res), reason: res ? 'MOCK_JOINED' : 'MOCK_NOT_JOINED' };
  }

  const key = `${state.username}|${idStr}`;
  if (!bypassCache) {
    const cached = memberCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return { isMember: cached.isMember, reason: cached.reason };
    if (inflight.has(key)) return inflight.get(key);
  }

  const p = lookupMembership(telegram, idStr, state, key);
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}
