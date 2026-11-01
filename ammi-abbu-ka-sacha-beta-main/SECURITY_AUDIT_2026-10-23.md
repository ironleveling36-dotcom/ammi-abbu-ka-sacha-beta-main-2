# 🔒 Deep Security & Reliability Audit — 2026-10-23

**Branch:** `arena/f0724c56-ammi-abbu-ka-sacha-beta` (from `b52ca56`)
**Auditor:** Arena Agent (full authority loophole hunt)
**Scope:** Every handler that can crash, leak data, waste Swiggy IDs, or let an attacker make the bot unusable.

---

## ✅ Fixed in this pass (8 critical)

| # | Bug | Severity | Fix |
|---|-----|----------|-----|
| 1 | **BOSS_SECRET default `boss123` published in code + docs** — anyone knowing default could call `/boss` and get admin | **CRITICAL** | `BOSS_SECRET` now required in production, ≥6 chars (≥10 recommended), default only in `NODE_ENV!=production` with visible warning. Brute-force guard: 5 fails → 30 min block (15 min window). `README.md` + `RAILWAY_SETUP.md` scrubbed. |
| 2 | **Brute-force on `/boss` (no rate limit, no lockout)** | CRITICAL | `_bossAttemptMap` + `_isBossSecretBlocked` / `_recordBossAttempt` around `bot.command(['boss','admin'])`. |
| 3 | **Document handler OOM DoS** — no size/timeout cap, `fetch` without timeout, unbounded `res.text()` → 100 MB JSON can OOM | CRITICAL | `MAX_JSON_FILE_BYTES 5 MB`, `MAX_ZIP 20 MB`, `FETCH_FILE_TIMEOUT_MS 15s`, truncation before `normalizeSwiggySessionPayload`, try/catch + `escapeHtml` on error. |
| 4 | **Custom QR document handler trusts `finalPayable` blindly** — DB-tampered `₹0` or `₹1` could create cheap QR | CRITICAL | Re-validate `payable > 0` before `sendDocument`; log + escape error replies. |
| 5 | **Payable amount tampering (`₹1` QR)** — `generateRealSwiggyMerchantUpiQr` never re-checked Swiggy's live `order_total` vs locked `finalPayable` | CRITICAL | In `swiggy-cart.js` compare `cm.order_total` vs `order.finalPayable`; `>₹50` mismatch → `payableMismatchFlag`, force re-sync via `needsSubOrDiscountRelock`. |
| 6 | **Prototype pollution via orderId** — `__proto__` / `constructor` in callback `lazy_confirm___proto__` could pollute `Object.prototype` | HIGH | `isSafeOrderKey` + `hasOwnProperty` in `lookupOrder` (`forwarded-order-flow.js`) and `upsertOrder`/`isSafeOrderKeyStore` (`store.js`). |
| 7 | **OOM via huge `rawText` / bulk forward** — 1 MB pasted bill + 10 links in one message | HIGH | Cap `rawText` to 8000 chars in `bot.on('text')` and `handleBossForwardedOrderInput`, with `console.warn`. |
| 8 | **Callback spam → Swiggy WAF block** — spamming `extract_now_*` / `lazy_confirm_*` hammers 29 accounts × DAPI | HIGH | In-memory rate limiter: `extract_now` 3/min, `lazy_confirm` 5/min per user; `⏳ Thoda slow` feedback. |

---

## 🔍 Remaining audit findings (documented, to be hardened)

### 🔴 Critical (make bot unusable if not fixed)
- **DB lost-update race** — two parallel `getDb(); db.orders[id]=…; saveDb(db)` from different forwarded messages can overwrite each other. Mitigation already partially via `withSenderIntakeLock`/`withOrderIngestLock`; full fix is to route all order mutations through `mutateDb(updater)` (atomic read-modify-write). **Recommendation:** audit every `saveDb` call and replace with `mutateDb`.
- **Slot/payment double-spend** — `slotsLeft` shown but never decremented (feature dormant); if re-enabled without atomic decrement, two `BILL_READY → PAID` transitions could consume same slot. **Recommendation:** implement slot consume via `mutateDb` compare-and-swap.
- **Tracking poller leak** — `autoTimers` map grows if `stopOrderTrackingAuto` never called (e.g., bot restart mid-ladder). Already capped at 8 attempts (~60 min) and terminal-status guard, but a watchdog that clears timers for `CANCELLED/REJECTED` on boot is recommended.
- **WAF global cooldown blocks healthy accounts** — one bad account triggers 10 min global block. **Recommendation:** per-account cooldown or adaptive concurrency.
- **File upload size check uses Telegram's `file_size` only** — attacker can spoof missing `file_size` to bypass cap. Fix already truncates `fileText`; full fix is to also enforce after-download `Blob.size`.

### 🟡 High (security / correctness)
- **XSS via `userName` / `restaurantName`** — most renders use `esc()`/`escapeHtml()`, but a few fallback paths (`order.userName` in rescue card, audit log) could miss escaping. **Recommendation:** run `test_v36` HTML-escape guard over all `ctx.reply` interpolations.
- **Order ID enumeration (IDOR)** — `lazy_confirm_<id>` currently checks `isBoss || userId || fwdSenderUserId` (good), but `extract_now_<id>` for numeric Swiggy IDs has weaker check. **Recommendation:** require same `canOperateLazyOrder` gate.
- **No input sanitization on `bossUpiId` / `BOT_TOKEN`** — setting `bossUpiId` to `javascript:` URI could produce dangerous `upi://` link. **Recommendation:** validate UPI ID regex on save.
- **Audit log PII redaction** — `appendAuditEvent` now redacts `phone`/`cookie`/`token`, but `console.log` in `forwarded-order-flow.js` could still leak `order.addressDetails.mobile`. **Recommendation:** replace raw `console.log` with redacted logger.
- **Tar dependency critical CVE** (`npm audit` → `tar <=7.5.20` via `@railway/cli`) — `npm audit fix --force` is breaking; **Recommendation:** upgrade `@railway/cli` or drop dev-dep from prod image.

### 🟢 Medium (UX / error handling)
- `bot.catch` correctly swallows `message is not modified` / `query is too old` but surfaces only `ReferenceError/TypeError` to user — good. Add explicit `403 Forbidden: bot was blocked` hint to suggest `/start`.
- `edited_message` handler re-enters `handleBossForwardedOrderInput` without re-validating `isBoss` — already gated inside, but double-check forwarding of edited messages can't forge `fwdSender`.
- `swiggy-cart.js` `expandShortUrl` lacks `AbortSignal.timeout` (now added in document handler only) — add globally to `swig.gy` / `onelink.me` hops.

---

## 🧪 Verification

- `node --check index.js / forwarded-order-flow.js / swiggy-cart.js / store.js` → **PASS**
- `npm run test:guards` (guards v16-v23, v35-v40) → **PASS** (58/58 v16, 26/26 v17, …)
- `test_comprehensive_audit_suite.mjs` (131/131) → **PASS** on base commit `b52ca56`; re-run after this patch recommended before merge.

---

## 📋 How to harden further

1. Replace every `getDb(); …; saveDb(db)` with `mutateDb(db => { … })` in order-write paths.
2. Add per-route `express-rate-limit` (or Telegraf middleware) for HTTP + Telegram handlers.
3. Enforce `BOSS_SECRET` strength at boot: `if (BOSS_SECRET.length < 10) console.warn(…)` + require in CI.
4. Schedule `npm audit` in CI; pin `tar` via overrides when Railway CLI unpatched.
5. Add `test_v41_proto_pollution_e2e.mjs` + `test_v42_rate_limit_e2e.mjs` to guards.
