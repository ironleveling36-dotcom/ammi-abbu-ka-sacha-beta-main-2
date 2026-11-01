// ============================================================================
// menu-labels.js — one source of truth for reply-keyboard text
// ----------------------------------------------------------------------------
// The bot registers a catch-all `bot.on('text')` very early. Anything it
// "consumes" never reaches the dedicated `bot.hears` / `bot.command` handlers
// registered later in index.js — that is how reply-keyboard buttons such as
// "📦 Orders Done" or "₹ Cash Loot" silently turned into the generic panel and
// how "▤ Order History" was misread as an order id.
//
// This module lists every label a keyboard can send so the catch-all can hand
// unknown menu text to its real handler, and so plain-text order ids never
// swallow menu labels. Keep it in sync with `getUserReplyKeyboard` /
// `getBossReplyKeyboard`.
// ============================================================================

// Labels that must reach a dedicated handler (never the generic fallback).
export const MENU_TEXTS = new Set([
  // Boss reply keyboard
  '★ Boss Panel',
  '▣ Pending Orders',
  '📦 Orders Done',
  '🔗 Extract Tracking Link',
  '▤ Order History',
  '× Cancelled Orders',
  // Legacy boss labels still sent by older keyboards
  'Slot Status', '● Slot Status', '# Slot Status',
  'Set UPI ID', '● Set UPI ID',
  'Login Swiggy', '○ Login Swiggy', '◈ Login Swiggy Account',
  'Login with JSON', '◈ Login with JSON',
  'Login with Number', '☎ Login with Number',
  'Connected Accounts', '● Connected Accounts', '◉ My Swiggy Accounts',
  'Saved Addresses', '● Saved Addresses', '⌖ Saved Addresses',
  'Claim Free Cash', 'claim free cash', 'Free Cash', 'free cash', '▣ Claim Free Cash',
  '₹ Cash Loot', '₹ Claim Free Cash',
  'Pending Orders', '● Pending Orders',
  '◉ Family Accounts',
  'Main Menu', 'Menu', 'Boss Panel', '⌂ Main Menu', '⌂ Boss Panel',
  'Close', 'close', '× Close',

  // Customer reply keyboard
  '🟠 🛒 Cart Link', '🟢 🛒 Cart ✓', '🟠 Cart Link', '🟢 Cart ✓',
  '🛒 Cart Link', 'Cart Link', '🛒 Cart ✓',
  '🟠 📍 Address Link', '🟢 📍 Address ✓', '🟠 Address Link', '🟢 Address ✓',
  '📍 Address Link', 'Address Link', '📍 Address ✓',
  '🚀 Send to Beta', 'Send to Beta', 'Send to Boss',
  '✖ Cancel Draft', 'Cancel Draft', '● Cancel Draft',
  '✖ Cancel Order', '✖ Cancel', 'Cancel Order',
  '📦 Previous Order', 'Previous Orders',
  '🛒 Start New Order', '🛒 New Order', 'Start New Order', 'New Order', 'Naya Order',
  '▣ Previous Orders', '▣ My Orders',
  '▤ View Cart',
  'i Add Food via Link'
]);

export function isMenuText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return MENU_TEXTS.has(value);
}

/**
 * Tiny commands that used to be swallowed by the catch-all text handler.
 * Returns true for `/anything` so commands reach `bot.command` handlers.
 */
export function isCommandText(text) {
  return /^\/[a-z0-9_]+/i.test(String(text || '').trim());
}

/**
 * A real order reference such as FWD1234 / ORD_5678 / 251144921143559.
 * Requires at least one digit, so words like "Orders" or "Order History" are
 * never mistaken for an order id.
 */
export function looksLikePlainOrderId(text) {
  const compact = String(text || '').trim().replace(/\s+/g, '');
  if (!compact) return false;
  if (/^\d{9,20}$/.test(compact)) return true;
  const match = compact.match(/^(?:FWD|ORD)[_-]?([A-Za-z0-9]{3,})$/i);
  if (!match) return false;
  return /\d/.test(match[1]);
}
