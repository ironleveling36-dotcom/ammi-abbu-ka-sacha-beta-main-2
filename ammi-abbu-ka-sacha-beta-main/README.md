# 👑 Ammi Abbu Ka Sacha Beta — Swiggy Live Order, Address & Cart Bot

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/hulm0408/ammi-abbu-ka-sacha-beta)

Telegram bot built for Swiggy food ordering with saved-address, group-cart, billing, and tracking integrations.

> **Verification note:** Historical descriptions and offline tests are not proof of a real Swiggy order, payment, tracking or recipient SMS. Checkout is experimental and configurable; see [Mini App setup and limitations](./MINI_APP_SETUP.md).

## 🚀 1-Click Render Deployment

1. Click **[Deploy to Render](https://render.com/deploy?repo=https://github.com/hulm0408/ammi-abbu-ka-sacha-beta)** above *(or open **[Render Dashboard](https://dashboard.render.com/)** -> **New +** -> **Web Service** -> select **`hulm0408/ammi-abbu-ka-sacha-beta`**)*.
2. Enter your **`BOT_TOKEN`** (from `@BotFather`) — set a strong **`BOSS_SECRET`** (e.g. `openssl rand -hex 16`) and `HEADLESS` (`true`) are already pre-configured.
3. Click **Apply / Deploy Web Service** — health check listens automatically on `0.0.0.0:$PORT` (`GET /` -> `200 OK`).

## 💬 Chat links → Mini App

1. Send the Swiggy **cart and address links** together or separately in private chat.
2. Open the Mini App, choose an authorized ID or Auto Choose, and confirm the fetched address and recipient.
3. Check the fetched cart, consent to replacing the selected Swiggy cart, and review the provider's bill before Pay Now.

All authenticated Telegram users can select current and future operator-uploaded IDs by default. Boss can revoke or restore a known user's access under **Tools → ID access**; user-owned accounts remain private and operator sessions cannot be exported by other users. The bot does not send recipient SMS; whether Swiggy sends one is unverified. Old chat orders remain available; [`SIMPLE_CHAT_FLOW.md`](./SIMPLE_CHAT_FLOW.md) documents the earlier chat-only flow. `SIMPLE_CHAT_MODE=0` changes legacy screens but does not disable the new production link handoff.

## 📍 Address intake rule (URL-first)

A Swiggy "Share address" message is the **only** source of delivery data:

* `https://swiggy.onelink.me/JgkQ/...` and `https://www.swiggy.com/ofo/address/...` are resolved through Swiggy's
  shared-address API — receiver name, phone, street, city and GPS all come from that response.
* Text pasted next to the link (order-account block, cart receipt, forwarded header, "Address: ..." line) is
  **never** parsed into the delivery address, so a forwarded bill can't hijack the recipient's number or area.
* If the link cannot be resolved, the bot asks for a fresh link/pin instead of guessing from chat text.
* A plain street address (or Telegram GPS pin) is still accepted when the message contains **no** address link.
* The delivery contact is always the receiver's number; the ordering Swiggy account's number is never substituted.
* **Only the URL is used.** Telegram keeps markdown, so a real paste often looks like
  `link:[https://swiggy.onelink.me/JgkQ/kubail4a](https://swiggy.onelink.me/JgkQ/kubail4a)` followed by
  `Address: …` and `It is a one time use link and will be valid for 24 hours.` All URL capture goes through
  `link-utils.js` (`extractSharedUrls` / `normalizeSharedUrl` / `stripSharedLinks`), so the markdown wrapper,
  the duplicated copy and every line of marketing text are dropped. The same applies to restaurant/group-cart
  links (`swig.gy/gc/...`), so a cart share message can never be read as an address and vice versa.

Order cards render as a compact receipt: `Order Account` → `Your Cart` → `Delivering To` → items →
`Bill Summary` → `To Pay`.

## 💬 One card per chat (no message spam)

Ammi/Abbu used to get a separate bubble for every step. Now:

* when a cart/address link is accepted, the customer's pasted message **and** the stale prompt bubbles are deleted,
* a single card is edited in place — it shows the cart, the resolved address, the items and the one
  `[ › Send to Beta ]` action,
* after Send to Beta the **same** card is edited: best account + max offer are applied automatically and the
  card becomes the bill summary with **✓ Approve bill**,
* the max-discount bill summary is rendered into that card (`billSummaryDelivery: SINGLE_CARD`) instead of
  another message — a plain message is only used when the card was deleted,
* approving sends the official Swiggy payment QR, and the verified payment sends the real Swiggy tracking link.

Cart and address data are never shortened or guessed to save messages — only the chat bubbles are reduced.

## 🧾 Payment QR, prompts and who receives the summary

* **Personalised QR.** After the customer approves the bill, the QR is drawn by `generateNamedUpiQrPngBuffer`
  (orange header with the customer's name, the exact amount and the order id inside the image). If Swiggy
  returns a payment URL instead, that official link is forwarded; if neither exists, the configured
  `bossUpiId` is used so the customer still gets a scannable QR (`paymentQrKind` records which one).
* **No leaked HTML.** Every message that contains `<b>/<i>/<code>` sets `parse_mode: 'HTML'` — enforced by a
  test that walks each `reply`/`sendMessage`/`editMessageText` call in the bot sources.
* **Interactive prompts.** `Paste Cart Link` / `Paste Address Link` send exactly one `force_reply` prompt
  (keyboard + placeholder). When the link arrives the prompt and the pasted message are deleted, so the chat
  keeps a single card. Repeated taps replace the prompt instead of stacking them.
* **Send to Beta with missing data** deletes the previous card and any prompt, then asks only for the missing
  cart link or address.
* **Summary routing** (`resolveBillSummaryAudience`): a Boss-forwarded / Boss-entered order keeps the bill
  summary **inside the bot** (`BOSS_ONLY`, the Boss card is the summary). A customer's own *Send to Beta*
  order goes to **both** (`CUSTOMER_AND_BOSS`) — the customer gets the confirm card, the Boss card shows the
  same bill.

## 🦥 Boss Lazy Mode — one forward, one tap

Ammi/Abbu text the Boss on his personal chat. The Boss forwards that message into the bot and from there
he should not have to think. `lazy-order-pilot.js` makes that true:

| Problem before | What happens now |
| :--- | :--- |
| **"Forward fetch failed"** | The forwarded text is stored on the order (`lastIntakeRawText`). Resolution is retried once automatically; if it still fails, the chat gets a **rescue card** — `↻ Retry fetch (same message)` — so nothing has to be forwarded again. Expired group carts still fail fast (no pointless retries). |
| **"Bot never asked me to confirm"** | No payment QR is created without an explicit tap. The bill card now leads with a single coloured button: **`✅ Confirm · for Ammi · ₹248`** (`lazy_confirm_<orderId>`). Auto-QR only bypasses it when `config.autoConfirmOrders === true` is set deliberately. |
| **"Best ID not selected"** | The automatic multi-probe pick is retried on transient/WAF errors, then a deterministic fallback ladder (`planAccountFallbacks`) walks every logged-in ID — 0-order → 0-active → the rest — and stops at the first live bill. Only a fully unusable vault returns to the Boss, on a card that says `BEST SWIGGY ID NAHI MILA` with `🔄 Best ID dobara try karo`. |
| **"No tracking link"** | After payment the existing poller pushes Swiggy's own link; the card also carries **`🔗 Tracking abhi`** (`lazy_track_<orderId>`), which force-scans every ID and always answers with either the genuine Swiggy link or the real `swiggy.com/orders` page plus a retry promise. No bot-side `/track/<id>` link is ever invented. |

Who the order is for is resolved from `config.familyMembers` (`setFamilyRole` → `Ammi`/`Abbu`), then the
forwarded name, then nicknames in the message (`mummy`, `papa`, …). That label is used on the confirm
button, the rescue card and the confirmation audit trail (`bossConfirmedAt`, `bossConfirmedBy`).

**Boss's whole workflow is now:** long-press Ammi's message → Forward → bot → tap **✅ Confirm** → scan the
QR. If Ammi sent the cart and the address as two messages, forward both — they pair into one order. If
anything breaks, the card itself carries the retry button.

## 🧪 Tests

```bash
npm test          # 131-scenario behavioural audit suite
npm run test:guards  # URL-only link intake, single-card chat, auto bill summary → QR → real tracking, /start smoke + static undefined-reference guard
npm run test:lazy    # Boss lazy mode: recipient detection, fetch retry, best-ID ladder, tracking fallback, confirm gate
```

`test:guards` fails if any bot source references an identifier that is never declared (the class of bug behind
`setUserMiniAppButton is not defined`).

## ⭐ Customer orders get the same auto-offer pipeline as forwarded ones

When a customer taps **Send to Beta** (or `Refresh status`), the bot now repeats the whole Boss-side pipeline
automatically, in the background:

1. resolve the live cart + delivery address,
2. scan every logged-in Swiggy account (`0-Order` first) for the best combination of coupon, free cash and
   free delivery,
3. lock that account + bill on the order (`cardStage: BILL_READY`, `autoOptimized: true`).

Nothing is charged or placed automatically. As soon as the max-discount bill is locked, the bot sends the
customer the **bill summary exactly once** (`billSummarySentAt` guard) with **✓ Approve bill** /
**! Something is wrong** buttons. Tapping *Approve* sends the official Swiggy payment QR/link straight to the
customer (no Boss step in between), consumes one slot and records `billApprovedByUser`.

After payment is verified the customer receives the **real Swiggy tracking link** that Swiggy itself returned.
The bot never substitutes its own `/track/<orderId>` page: if Swiggy has not published a link yet, the message
says so (with a plain `swiggy.com/orders` shortcut) and the tracking poller pushes the exact link later.

If no free account is available the order simply stays pending and the reason is shown on the Boss card
(`Auto offers: …`), so Boss can retry with **★ Auto Max Coupon**. Boss's *Send Bill Summary* button is now a
manual **resend** of that same summary — it can never bill the customer twice.
