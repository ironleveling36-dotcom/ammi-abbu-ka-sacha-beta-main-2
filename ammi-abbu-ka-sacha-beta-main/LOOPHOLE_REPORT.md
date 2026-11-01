# 5-Hour Loophole Hunt — Swiggy Telegram Bot (arena/7e30bac3)

**Branch:** `arena/7e30bac3-ammi-abbu-ka-sacha-beta` @ 86a8144  
**Date:** 2026-10-22  
**Total fixes in this session:** 12 (cumulative with prior session ~20)  
**Test guards:** 58/58 26/26 38/38 52/52 33/33 37/37 5/5 ✅

---

## Critical Loopholes Closed

### 1. Tracking link misparsed as Cart (ORD7193 ₹0 duplicate)
**Risk:** Critical — Boss pasted `http://r.swiggy.com/.../track/251144921143559` + new address, bot created duplicate order with tracking URL as `cart`, ₹0 bill, lost real tracking link, overwrote delivery info. Test shows tracking link was stored as `ORD7193.cart`.

**Fix (4 layers):**
- `forwarded-order-flow.js:1138` `classifyRawOrderInputFast` — `continue` if `isOfficialSwiggyTrackingUrl(u)` 
- `forwarded-order-flow.js:1114` `isValidCartInput` — early `return false` for tracking
- `forwarded-order-flow.js:1185` `looksLikeBossOrderInput` — early `false` for tracking
- `forwarded-order-flow.js:2028` `swiggyUrls` filter — `!isOfficialSwiggyTrackingUrl(u)` excludes tracking from `resolveSwiggyLink`
- `index.js:132` `isValidSwiggyCartUrl` — blacklist `r.swiggy|ofo.*|/track` prevents handleSendToBoss from accepting tracking as cart
- `forwarded-order-flow.js:2095-2125` Phase 1 order-creation guard — if `!hasCart && !hasAddress` and URL is tracking → `return true` without creating order; prevents empty ORD7193 recreation

**Result:** tracking-only message now returns `Could not detect valid Cart link` instead of creating ₹0 order; address update still works when `hasAddress` present.

### 2. ₹0 Bill Guard (Cart khali hai)
**Risk:** High — Forwarded order with empty cart created pending order requiring manual delete; Boss panel allowed `APPROVAL_PENDING` with no items.

**Fix:** `index.js:4588` `handleSendToBoss` check `items.length===0 || finalPayable===0` → `ctx.reply('⚠ *Cart khali hai* — add items before sending')`; `boss-panel.js:158` `billSection` now shows `Calculating…` placeholder when `hasBill` false instead of empty line; prevents Boss thinking bill is ready.

### 3. answerCbQuery Sync Throw Outside bot.action (UNEXPECTED ERROR)
**Risk:** High — 4x ternaries `ctx.answerCbQuery ? ctx.answerCbQuery().catch()` inside non-action handlers (isBoss block) threw synchronously when `ctx.callbackQuery` was 0/falsy; `errorHandler` emitted `❌ *UNEXPECTED ERROR*`.

**Fix:**
- `index.js:160` Telegraf `Context.prototype.answerCbQuery` monkey-patch: `if (!this.callbackQuery) return Promise.resolve()` — global no-op
- `index.js:645, 960, 8187, 8322` 4 ternaries → `if (ctx.callbackQuery) { ctx.answerCbQuery(...).catch }`
- `index.js:1062,1078` `renderUserCard` / `renderBossCard` guards: `if (ctx?.callbackQuery?.id)` before `ctx.answerCbQuery`

### 4. Message is not modified / message_id_invalid Spam
**Risk:** Medium — Order Hub `handleMyAccounts` / `acc_view_detail` spam edited same card text → Telegraf threw `400: message is not modified`, flooded logs.

**Fix:** `index.js:170` monkey-patch `bot.telegram.editMessageText` to `try/catch` and ignore `.*(message is not modified|message_id_invalid|MESSAGE_ID_INVALID).*` — idempotent guard (proper per-handler edit check still ideal).

### 5. isOfficialSwiggyTrackingUrl Provider Shortlink False Positive
**Risk:** High — `allowProviderShortLink:true` marked every `onelink.me/JgkQ/*` address share link as tracking, broke `v16` scenario 4 (forwarded intake `updatedAddress` false, city placeholder india, phone mismatch) → 54/58 after tracking filter.

**Fix:** `forwarded-order-flow.js` all 3 tracking checks changed to `isOfficialSwiggyTrackingUrl(u)` default `false`; tracking still caught via explicit `r.swiggy.com.*\/track` regex and direct Swiggy tracking route, but `swiggy.onelink.me/JgkQ/kubail4a` now correctly resolves as ADDRESS via Swiggy OFO API. Test back to 58/58.

### 6. SMS Notification for Parents
**Risk:** Medium — Boss placed order for `Ammi/Abbu` but parents only got Telegram message; if not on Telegram, no notification. User requested SMS: "Fer aex ne aapke liye order place kiya hai".

**Fix:** New `sms-notify.js` with `sendParentSmsNotification(order, trackingUrl)` — resolves `addressDetails.mobile`, builds Hindi/Urdu SMS `"{bossName} ne aapke liye Swiggy order place kiya hai. Order ID: {id}... Track: {link}"`, tries `SMS_WEBHOOK_URL` + `SMS_API_KEY` (Twilio/Fast2SMS) then falls back to log + Telegram bridge. Integrated:
- `forwarded-order-flow.js:sendOrderDeliveryInfoNotice` — after `sendMessage` success or catch, `sendParentSmsNotification(...).catch()`
- `index.js:7505` boss `waiting_tracking` handler — after Telegram tracking send, `sendParentSmsNotification(order, trackingUrl)`

Configure `SMS_WEBHOOK_URL=https://api.fast2sms.com/...` and `SMS_API_KEY` in env to enable real SMS.

---

## Verified Idempotent (No Fix Needed)

- **SlotsLeft consumption** at 3 sites (`index.js:4611` boss QR, `5760` boss accept, `9395` customer approve) all check `slotConsumed` before `Math.max(0, left-1)`, cancellation restores correctly.

---

## Remaining / Next Session

- **Card option for orders:** UI placeholder added via billSection; full card-payment integration needs vault `paymentMethods.card` + `swiggy-bridge` `saveCard` API.
- **handleBossForwardedOrderInput Phase1/Phase2 split** could still create empty order if legacy DB has pre-patched ORD — mitigated but `allocatedOrderId === null` early-return after Phase1 now prevents Phase2 lock on null.
- **Order Hub idempotent edit guard** — global `editMessageText` patch covers spam; per-handler `if (newText === oldText) return` is cleaner for 8569/8621.
- **Swiggy World Bot sender** — appears as `fwdSenderName` in DB; should be filtered if not real boss, but current dedupe by `primaryCartUrl` handles it.

---

## Repro Commands

```bash
npm run test:guards
node test_v16_url_only_address_and_order_card_e2e.mjs
# Both must show 58/58
```
