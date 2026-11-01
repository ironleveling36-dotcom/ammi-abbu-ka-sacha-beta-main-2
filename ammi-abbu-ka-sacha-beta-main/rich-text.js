// ============================================================================
// rich-text.js — Free Telegram rich-message helpers (HTML parse_mode)
// ============================================================================
// Provides Telegram blockquote sections, bold headings, and readable field lists.
// Telegram messages do not support real tables, so data is rendered as compact
// item/field lines instead of fake monospace grids and separator rules.

export const DIVIDER = '';
export const SECTION_GAP = '\n';

export function esc(str = '') {
  return String(str ?? '')
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#39|#\d+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Bold heading
export function heading(text) {
  return `<b>${esc(text)}</b>`;
}

// Subtle subtext line
export function sub(text) {
  return `<i>${esc(text)}</i>`;
}

// Field line: <b>Label:</b> value
export function field(label, value) {
  return `<b>${esc(label)}:</b> ${esc(value)}`;
}

// Bullet item
export function bullet(text) {
  return `▪ ${esc(text)}`;
}

// Bordered section block (Telegram <blockquote> renders as a card with a left border).
// `body` is trusted internal HTML already built with esc()/field()/table()/heading()/sub().
export function section(title, body) {
  const t = title ? `${heading(title)}\n` : '';
  return `<blockquote>${t}${body}</blockquote>\n`;
}

// Bordered card: title + multiple body lines joined by newline
export function card(title, ...lines) {
  return section(title, lines.filter(Boolean).join('\n'));
}

function safeTableCell(value) {
  const input = String(value ?? '');
  const allowedTags = [];
  let safe = input.replace(/<\/?(?:b|i|code|s|u|tg-spoiler)>|<a href="(?:https:\/\/|tg:\/\/)[^"]+">|<\/a>/gi, tag => {
    const token = `\u0000SAFE_TAG_${allowedTags.length}\u0000`;
    allowedTags.push(tag);
    return token;
  });
  safe = safe
    .replace(/&(?!(?:amp|lt|gt|quot|#39|#\d+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return safe.replace(/\u0000SAFE_TAG_(\d+)\u0000/g, (_match, idx) => allowedTags[Number(idx)] || '');
}

// Telegram has no table primitive. Render data as readable list entries with no
// fake columns, dash rules, or monospace border art.
export function table(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const normalized = rows.map(row => Array.isArray(row) ? row : [row]);
  const headers = normalized[0].map(value => String(value ?? '').replace(/<[^>]+>/g, '').trim());
  const isItemList = headers.some(h => /^item$/i.test(h));
  const hasColumnHeaders = normalized.length > 1 && headers.length >= 3;

  if (hasColumnHeaders && isItemList) {
    const itemIndex = headers.findIndex(h => /^item$/i.test(h));
    const qtyIndex = headers.findIndex(h => /^qty|quantity$/i.test(h));
    const priceIndex = headers.findIndex(h => /^(?:unit )?price$/i.test(h));
    const totalIndex = headers.findIndex(h => /total/i.test(h) && h !== '#');
    const numberIndex = headers.findIndex(h => /^#|no\.?$/i.test(h));
    return normalized.slice(1).map((row, index) => {
      const item = safeTableCell(row[itemIndex] ?? 'Item');
      const itemNumber = numberIndex >= 0 ? String(row[numberIndex] || index + 1) : String(index + 1);
      const details = [];
      if (qtyIndex >= 0 && row[qtyIndex] !== undefined) details.push(`Qty: ${safeTableCell(row[qtyIndex])}`);
      if (priceIndex >= 0 && row[priceIndex] !== undefined) details.push(`Unit price: ${safeTableCell(row[priceIndex])}`);
      if (totalIndex >= 0 && totalIndex !== priceIndex && row[totalIndex] !== undefined) {
        details.push(`${safeTableCell(headers[totalIndex])}: ${safeTableCell(row[totalIndex])}`);
      }
      return `${itemNumber}. <b>${item}</b>${details.length ? `\n  ${details.join(' · ')}` : ''}`;
    }).join('\n');
  }

  if (hasColumnHeaders) {
    const titleIndex = headers.findIndex(h => !/^#|no\.?$/i.test(h));
    return normalized.slice(1).map(row => {
      const rawTitle = titleIndex >= 0 ? String(row[titleIndex] ?? '') : '';
      const title = safeTableCell(rawTitle);
      const titleMarkup = /<\/?(?:b|i|code|s|u|tg-spoiler)>/i.test(rawTitle) ? title : `<b>${title}</b>`;
      const details = headers
        .map((header, idx) => ({ header, value: row[idx], idx }))
        .filter(({ header, value, idx }) => idx !== titleIndex && !/^#|no\.?$/i.test(header) && value !== undefined && value !== '')
        .map(({ header, value }) => `  <b>${safeTableCell(header)}:</b> ${safeTableCell(value)}`);
      return `${title ? `▪ ${titleMarkup}` : '▪'}${details.length ? `\n${details.join('\n')}` : ''}`;
    }).join('\n');
  }

  const dataRows = normalized.filter((row, idx) => !(idx === 0 && /^final bill$/i.test(String(row[0] || '').trim()) && !String(row[1] || '').trim()));
  return dataRows.map(row => {
    const rawLabel = String(row[0] ?? '');
    const label = safeTableCell(rawLabel);
    const labelMarkup = /<\/?(?:b|i|code|s|u|tg-spoiler)>/i.test(rawLabel) ? label : `<b>${label}</b>`;
    const value = row.length > 1 ? safeTableCell(row[1] ?? '') : '';
    return `▪ ${labelMarkup}${value ? `: ${value}` : ''}`;
  }).join('\n');
}

// Standalone section divider — leave breathing room rather than drawing a fake rule.
export function divider() {
  return '\n';
}

// A full clean message wrapper: heading + sections + footer note
export function message(title, sections = [], footer = '') {
  const parts = [];
  if (title) parts.push(heading(title), divider());
  for (const s of sections) parts.push(s);
  if (footer) parts.push(divider(), sub(footer));
  return parts.join('\n');
}

// Clean OTP Sent card — matches ORDER PLACER style: bold label + value, no ━━━
export function otpSentCard(phone, extraLines = []) {
  const lines = [
    `<b>☎ OTP Sent</b>`,
    `☎ <b>Number:</b> <code>${esc(phone)}</code>`,
    ...extraLines
  ];
  return section('◈ Swiggy Login OTP', lines.join('\n'));
}

// Clean OTP error / verification failed card — matches ORDER PLACER style
export function otpErrorCard(phone, swiggyResponse, hint = 'Sahi 6-digit OTP dubara type karein ya neeche Re-enter OTP dabayein:') {
  return section('× OTP Request Failed', [
    `☎ <b>Number:</b> <code>${esc(phone)}</code>`,
    '',
    `! <b>Swiggy Response:</b>`,
    `<blockquote>${esc(swiggyResponse)}</blockquote>`,
    '',
    `› <i>${esc(hint)}</i>`,
  ].join('\n'));
}

// Clean Boss Panel fallback card
export function bossPanelCard(bodyLines = []) {
  return section('★ Boss Panel', [
    `→ Boss, use the menu buttons below:`,
    ...bodyLines,
  ].filter(Boolean).join('\n'));
}
