// Per-account scan diagnostics for NOT_FOUND replies (moved out of index.js so
// it is unit-testable without booting the bot).
//
// Live incident 2026-10-22: after sustained auto-retries + boot catch-up,
// Swiggy's WAF rate-limited the bot's IP and EVERY account's list/detail calls
// were rejected. The old wording labelled all of them "session expired" and
// told the boss to re-login 29 active accounts — wrong, and it made the user
// angry ("kuch bhi sense nahi"). Massive simultaneous failures are a WAF/rate
// limit pattern, not 29 dead sessions.

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const WAF_HINT = /waf|challenge|rate.?limit|rate limit|too many|blocked|throttl|cloudfront|\b403\b|cf-|captcha/i;

/**
 * Render the diagnostics block for an all-IDs scan result:
 *  - "Scan incomplete" when a TIMEOUT only reached a subset of accounts
 *  - "Checked: N OK · M failed" coverage line
 *  - per-account failure details, with a WAF/rate-limit aggregate label when
 *    the majority of accounts failed at once (retry-later advice instead of
 *    "re-login everything")
 */
export function scanFailuresLine(result) {
  const fails = Array.isArray(result?.failures) ? result.failures : [];
  const ok = Number(result?.okScanned) || 0;
  let out = '';
  const total = Number(result?.accountsTotal) || 0;

  if (result?.status === 'TIMEOUT' && total > 0 && (ok + fails.length) < total) {
    out += `⚠ <b>Scan incomplete:</b> sirf ${ok + fails.length}/${total} IDs check hue (time out) — <b>dobara bhejo</b>, agle try me baaki bhi scan honge.\n`;
  }
  if (ok > 0 || fails.length > 0) {
    out += `▪ <b>Checked:</b> ${ok} IDs OK (no order)${fails.length ? ` · <b>${fails.length}</b> failed` : ''}\n`;
  }

  if (fails.length) {
    const details = fails.map(f => String(f.detail || '')).join(' ');
    const majorityFailed = total > 0 && fails.length >= 3 && fails.length >= Math.ceil(total / 2);
    const wafPattern = WAF_HINT.test(details);

    const shown = fails.slice(0, 6).map(f =>
      `<code>${escapeHtml(String(f.phone || f.key || '?'))}</code> (${f.reason === 'SESSION_EXPIRED' ? 'session expired' : 'auth fail'})`
    ).join(', ');
    const more = fails.length > 6 ? ` +${fails.length - 6} aur` : '';

    if ((majorityFailed || wafPattern) && fails.length >= 3) {
      // Systematic rejection: almost every account failed at once. This is
      // Swiggy rate-limiting/WAF-blocking the bot (sustained auto-retries),
      // NOT a fleet of dead sessions — re-login advice would be wrong.
      out += `⚠ <b>Swiggy ne rate-limit/WAF lagaya hoga</b> (${fails.length}${total ? `/${total}` : ''} accounts ek saath fail) — bots ki zyada scans ke baad aisa hota hai.\n`;
      out += `▪ <b>Abhi ID dobara mat bhejo</b> — <b>10–15 min</b> baad retry karo, tab tak Swiggy thanda ho jayega. Sessions zinda hain, bas calls block hui hain.\n`;
      out += `▪ <i>Fails:</i> ${shown}${more}\n`;
    } else {
      out += `▪ <b>Scan errors:</b> ${shown}${more} — in accounts ko <b>My Accounts</b> se dobara login karke retry karo.\n`;
    }
  }
  return out;
}

export { escapeHtml };
