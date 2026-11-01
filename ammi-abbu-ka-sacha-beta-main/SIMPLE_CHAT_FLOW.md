# 🍽 Simple Chat Order Flow (no web app)

**Goal:** the customer sends **only two Swiggy links**, taps **one Confirm button**, and
receives the **official Swiggy tracking link** — all inside the Telegram chat.
This chat flow does not require the optional Mini App, forms, or typing. The separately configured Mini App and its limitations are described in [MINI_APP_SETUP.md](./MINI_APP_SETUP.md).

```
Customer chat                                  Bot
──────────────────────────────────────────────────────────────────────────────
🛒 cart link + 📍 address link  ──────────────▶  reads links, resolves cart + address
                                                 auto picks best account + max offer
                                 ◀──────────────  🧾 Confirm your order · To Pay ₹487
                                                     [ ✅ Confirm ₹487 ]
                       tap ✅ Confirm ──────────▶  consent stored on the order
                                 ◀──────────────  💳 Pay ₹487  (personalised QR)
                       pay + tap ✓ I have paid ─▶ verify with Swiggy
                                 ◀──────────────  🛵 Tracking link aa gaya
                                                     [ 🛵 Track on Swiggy ]  + OTP
```

## What the customer has to do

| Step | Input |
| :--- | :--- |
| 1 | Paste the Swiggy **Cart link** and **Address link** (one message or two) |
| 2 | Tap **✅ Confirm ₹amount** (this is the consent) |
| 3 | Pay the QR / Swiggy payment link, tap **✓ I have paid** |
| 4 | Tap **🛵 Track on Swiggy** |

That is `2 pastes + 2 taps`. Nothing is typed, nothing opens outside Telegram.

## Consent is recorded, not assumed

Tapping Confirm writes these fields on the order **before** any payment QR is created:

| Field | Meaning |
| :--- | :--- |
| `customerConsentGiven` | `true` only after the customer's own tap |
| `customerConsentAt` | ISO timestamp of the tap |
| `customerConsentBy` | Telegram user id of the customer |
| `customerConsentVia` | `TELEGRAM_BUTTON` |
| `customerConsentAmount` | ₹ amount shown on the button at that moment |
| `customerConsentText` | Human-readable audit line (`No web app / mini-app was used`) |

Nothing is charged, placed or scanned on the customer's behalf before this record exists.
If the bill is still being computed when they tap, the consent is kept and the payment QR
is sent automatically the moment the max-offer bill is ready (`autoApproveConsentedSimpleOrder`).

## Delivery mobile number (zero typing)

The Swiggy address share already contains the receiver's number, so the old
"send the 10-digit mobile number" prompt is skipped in simple mode. If Swiggy omits it,
the bot falls back to the saved number of the Swiggy account used for the order and records
`addressDetails.mobileSource = ACCOUNT_FALLBACK | MISSING` instead of blocking the order.

## Tracking link

* The link is the **real Swiggy link** (`getStoredSwiggyTrackingUrl`): `r.swiggy.com/...`,
  `swiggy.com/orders/...`, `swiggy.com/track/...` or `swig.gy/...`. A bot-side `/track/<id>`
  page is never used for customers.
* It is delivered **once** as its own short bubble with a `🛵 Track on Swiggy` URL button
  (`simpleTrackingSentFor` guard) — even if the customer deleted the QR message.
* Delivery OTP and live status are included when Swiggy provides them.

## Screens (customer only)

| Stage | Card | Buttons |
| :--- | :--- | :--- |
| No links | `🛒 Cart: —` / `📍 Address: —` + "paste both links" | `📋 Cart + Address link paste karein` |
| One link | the saved side is ticked, the missing side is named | same paste action, `✖ Clear` |
| Bill ready | restaurant, items, address, `To Pay ₹x` | `✅ Confirm ₹x`, `🔄 Refresh`, `✖ Cancel` |
| Payment | amount + "QR upar bheja gaya hai" | `💳 Pay on Swiggy` (if Swiggy returned a URL), `✓ I have paid — get tracking` |
| Tracking | Swiggy id, status, OTP | `🛵 Track on Swiggy`, `🔄 Refresh status`, `🏁 Finish` |
| Cancelled | reason | `🛒 Naya order` |

The bottom reply keyboard in simple mode is just `🛒 New Order` / `📦 Orders Done` / `🔗 Extract Tracking Link`.

## Switch it off

```bash
SIMPLE_CHAT_MODE=0   # brings back the older multi-topic customer screens
```

Simple mode is the default in production (`Dockerfile`, `render.yaml` set `SIMPLE_CHAT_MODE=1`)
and automatically disabled inside the legacy offline suites (`TEST_MODE=1`).

## Code map

| File | Responsibility |
| :--- | :--- |
| `simple-chat.js` | pure screen builders (`buildSimpleHomeScreen`, `buildSimpleOrderCard`, `buildSimpleTrackingMessage`) + consent patch + stage detection |
| `index.js` | wiring: `/start`, link intake, `simple_*` callbacks, `startSimpleOrderFromDraft`, `autoApproveConsentedSimpleOrder`, `sendSimpleTrackingOnce` |
| `test_v40_simple_chat_consent_tracking_e2e.mjs` | 46 offline checks (screens, consent record, QR-on-consent, tracking once, no web app) |

Run the checks:

```bash
node test_v40_simple_chat_consent_tracking_e2e.mjs
npm run test:guards
```
