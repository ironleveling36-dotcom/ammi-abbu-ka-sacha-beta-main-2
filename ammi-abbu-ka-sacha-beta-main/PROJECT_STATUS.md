# PROJECT STATUS & REQUIREMENTS REGISTER

**Project Name:** Ammi Abbu Ka Sacha Beta (`telegram-slot-bot`)  
**Repository Branch:** `ammi-main` (synchronized with `upstream-ammi/main`)  
**Current Date:** 2026-10-22  
**Engineering Standard:** PROJECT ENGINEERING PROTOCOL — NO FALSE COMPLETION  

---

## 1. Project Goal & Scope
An automated Telegram ordering, billing, and tracking bot designed for family members ("Ammi & Abbu") and customers to place Swiggy food orders seamlessly without confusing app UIs or manual slot coordination.
- **Core Objectives:**
  - Automated dual-link intake (Shared Cart + Delivery Address URL) directly from Telegram chat or forwarded messages.
  - Multi-account Swiggy vault orchestration with automatic selection of fresh 0-order accounts and maximal promotional coupon stacking.
  - Immediate login-time offer pre-fetching (Breakfast, Late-Night, welcome promotions) with zero latency during checkout.
  - Interactive 4-topic single-card progression in Telegram (Link -> Bill & Confirm -> Payment & QR -> Live Tracking).
  - Clean permanent logout with anti-revival tombstones synchronized to GitHub Cloud Vault.
  - Personalised UPI payment QR generation and delivery of genuine official Swiggy order tracking links + delivery OTPs.

---

## 2. User Roles & Permissions

| Role | Identification | Permissions & Responsibilities |
| :--- | :--- | :--- |
| **Customer / Parent ("Ammi/Abbu")** | Telegram `userId` (`ctx.from.id`), not present in `bossIds` | Submit cart/address links, approve/reject generated bill summaries, scan UPI payment QRs, receive official Swiggy tracking links & delivery OTPs. Restricted from accessing boss controls, raw accounts, or session tokens. |
| **Boss / Operator** | Telegram `userId` listed in `db.config.bossIds` or verified via `/boss <BOSS_SECRET>` | Full administrative dashboard: Upload `.json` Swiggy sessions, trigger manual slot audits, inspect order queues, re-trigger coupon optimizations, permanently logout/tombstone accounts, view raw accounting & audit logs. |
| **System / Background Daemon** | Internal workers (`order-tracking.js`, `vault-sync.js`, WAF breaker) | Auto-poll tracking endpoints for active orders, refresh session validity, backup session tombstones to cloud vault, manage WAF backoff pools. |

---

## 3. Complete User Flows

### Flow A: Customer Ordering Journey (4-Topic Progression)
1. **Topic 1: Submit Link**
   - User opens chat (`/start`) or drops raw text / forwarded messages containing Swiggy cart link (`swig.gy/gc/...`) and address link (`swiggy.onelink.me/JgkQ/...` or `maps.app.goo.gl`).
   - Bot parses both links in parallel via `Promise.all` (`resolveSwiggyLink`), extracts recipient phone from text, and updates draft state.
   - Status transitions to Topic 2 once valid cart and address are stored.
2. **Topic 2: Bill & Confirmation**
   - Bot inspects account pool, excludes tombstoned accounts, auto-selects optimal 0-order / highest-coupon account.
   - Computes item totals, discounts, packaging, taxes, and net payable.
   - Renders Single-Card with Topic Header, Horizontal Slide buttons (`[ ◀ Prev ] [ Topic 2/4: Bill ] [ Next ▶ ]`), itemized breakdown, and `[ 🔄 Change Auto Selection ]`.
   - Customer taps `[ ✓ Approve Bill ]`.
3. **Topic 3: Payment & QR**
   - Bot marks bill approved, moves status to `PAYMENT_PENDING`.
   - Generates personalized orange UPI QR code with customer name, order ID, and amount embedded inside the QR matrix center badge (`generateNamedUpiQrPngBuffer` / `generatePersonalizedQrCard`).
   - Customer scans QR or taps `[ I've Paid ]`.
4. **Topic 4: Live Tracking & Finish**
   - Order marked `ACCEPTED` / `PAID`.
   - Background poller detects Swiggy order placement, extracts genuine Swiggy OFO tracking URL (`swiggy.com/menu/...` or `trackV4`), delivery partner status, and delivery OTP.
   - Customer is presented with official tracking button and `[ 🏁 Finish & Start New Order ]`, resetting the card back to Topic 1 cleanly.

### Flow B: Account Intake & Pre-Fetch
1. Operator drops `.json` session files into Telegram chat.
2. Bot decrypts, validates cookies, and checks past order history (`totalOrdersCount`).
3. If 0 past orders detected:
   - Immediately executes `claimOffersFn` for Breakfast and Late-Night offers.
   - Calculates `possibleDiscountsCount` and stores on the account profile.
4. Account is saved into `db.config.accounts` and synced to Cloud Vault.

### Flow B2: Lazy Boss Autopilot (forward → confirm → paid → tracked)
1. Boss forwards Ammi/Abbu's personal message into the bot. `extractForwardSenderInfo` identifies the sender;
   `detectRecipientRole` resolves Ammi/Abbu from `config.familyMembers`, then the forwarded name, then nicknames.
2. `handleBossForwardedOrderInput` bookmarks the raw text (`lastIntakeRawText`) and resolves cart + address.
   A transient failure is retried once; a hard failure renders the **rescue card** (`FETCH_FAILED`) with
   `↻ Retry fetch (same message)` — no re-forward needed.
3. `autoAssignBestAccountWithFallback` picks the best ID (`BEST` twice, then the deterministic
   `planAccountFallbacks` ladder) and locks the max-discount bill.
4. The bill card leads with one coloured button: `✅ Confirm · for Ammi · ₹248` (`lazy_confirm_<id>`).
   Only this tap (or `config.autoConfirmOrders === true`) can generate the official Swiggy payment QR.
5. After payment the tracking poller pushes Swiggy's genuine link; `lazy_track_<id>` gives an on-demand
   force-scan that always returns the real link or `swiggy.com/orders` + a retry promise.

### Flow C: Permanent Account Logout
1. Operator or lifecycle routine triggers logout for `acc_<phone>`.
2. Account is marked `isLoggedIn: false`, `isLoggedOut: true`, session tokens cleared.
3. Removed from `db.config.accounts` active pool.
4. Tombstone written to `db.config.deletedAccounts[key]` and `db.config.deletedAccounts[phone]`.
5. Session purged from `db.sessionVault`.
6. Cloud Vault immediately synced so restarts cannot revive the logged-out session.

---

## 4. Functional Requirements

| ID | Requirement | Verification Status |
| :--- | :--- | :--- |
| **FR-01** | Dual-link parallel ingestion from single forwarded message (Cart + Address) | **VERIFIED** |
| **FR-02** | URL-first delivery address extraction (no chat text poisoning) | **VERIFIED** |
| **FR-03** | 4-Topic progression with level-by-level lock enforcement | **VERIFIED** |
| **FR-04** | Horizontal topic slider controls (`[ ◀ Previous ]`, `[ Next ▶ ]`) | **VERIFIED** |
| **FR-05** | Login-time 0-order detection and immediate offer pre-fetch & claim | **VERIFIED** |
| **FR-06** | Pre-calculation of `possibleDiscountsCount` on account intake | **VERIFIED** |
| **FR-07** | Permanent account logout with tombstone prevention in Cloud Vault | **VERIFIED** |
| **FR-08** | Automated account auto-selection without manual account pickers | **VERIFIED** |
| **FR-09** | Cycle account via `[ 🔄 Change Auto Selection ]` button | **VERIFIED** |
| **FR-10** | Single-card chat interface (message edits in-place, no bubble spam) | **VERIFIED** |
| **FR-11** | Personalised UPI QR card generation with embedded customer metadata | **VERIFIED** |
| **FR-12** | Extraction and delivery of genuine official Swiggy tracking links (no bot proxies) | **VERIFIED** |
| **FR-13** | Delivery OTP extraction and push notification to recipient mobile | **VERIFIED** |
| **FR-14** | Circuit-breaker and backoff against Swiggy WAF / rate limits | **VERIFIED** |
| **FR-15** | Accurate order count detection without 999999 fallbacks (`inspectAccountOrderHistoryAndOffers` polymorphic handling) | **VERIFIED** |
| **FR-16** | Automatic account assignment to active pending draft order upon login | **VERIFIED** |
| **FR-17** | Seamless account selection & assignment with order persistence across sync retries | **VERIFIED** |
| **FR-18** | Explicit diagnostic error messaging on account issues (session expired, WAF challenge, auth failure) | **VERIFIED** |
| **FR-19** | Order count display (`0 Orders` or `X Orders`) in Connected Accounts list and Account Detail cards | **VERIFIED** |
| **FR-20** | Clean account logout, vault purge, and tombstone protection preventing resurrection of old accounts | **VERIFIED** |
| **FR-21** | Lazy Boss intake: forwarded family message is stored (`lastIntakeRawText`) and retried once automatically before any manual step | **VERIFIED** (test_v40) |
| **FR-22** | One-tap explicit confirmation (`lazy_confirm_<id>`) required before any payment QR is generated (`autoConfirmOrders` opt-out only) | **VERIFIED** (test_v40) |
| **FR-23** | Best-ID fallback ladder across every logged-in account (0-order → 0-active → rest) with automatic retry of transient failures | **VERIFIED** (test_v40) |
| **FR-24** | Tracking never dead-ends: genuine Swiggy link or the real `swiggy.com/orders` page + explicit retry promise (`lazy_track_<id>`) | **VERIFIED** (test_v40) |
| **FR-25** | Recipient role resolution (family tag → forwarded name → nickname) drives the confirm label and confirmation audit trail | **VERIFIED** (test_v40) |

---

## 5. Non-Functional Requirements

- **Latency:** Initial bill calculation under 2.5s via parallelized metadata resolution.
- **Security:** Zero plaintext session export in git; all session tokens kept in local encrypted vault and secured environment variables.
- **Resilience:** Health check on `0.0.0.0:$PORT` for Docker/Render deployment; unhandled errors caught to prevent bot process crashes.
- **Data Integrity:** Strict schema validation in `store.js` with atomic writes to `data/db.json`.

---

## 6. Current Architecture

```
[ Telegram Bot API ]
         │
         ▼
    [ index.js ] ─────────── (Telegraf Router & Event Dispatcher)
         │
         ├── [ forwarded-order-flow.js ]  (Dual Link Ingestion & Bill Card Builder)
         ├── [ ammi-abbu-topic-flow.js ]  (4-Topic Progression & Slider Navigation)
         ├── [ account-vault-intake.js ] (Session Intake, 0-Order Check & Offer Pre-fetch)
         ├── [ swiggy-cart.js ]          (Link Resolution, Cart Parsing, QR Generator)
         ├── [ swiggy-bridge.js ]        (Swiggy DAPI / MAPI / HTTP Client & Session Injector)
         ├── [ order-tracking.js ]       (Poller for Live Status, OFO Links & OTPs)
         ├── [ store.js ]                (Local DB, Tombstones, Drafts, Audit Logs)
         └── [ vault-sync.js ]           (GitHub Encrypted Cloud Vault Sync)
```

---

## 7. Implemented Features & Verification Status

| Feature Component | Implementation File | Status | Verification Evidence |
| :--- | :--- | :--- | :--- |
| Topic Slider & Locks | `ammi-abbu-topic-flow.js` | **VERIFIED** | 42/42 checks passed in `test_v35_ammi_abbu_topics_progression_e2e.mjs` |
| Login Offer Pre-Fetch | `account-vault-intake.js`, `index.js` | **VERIFIED** | Checks 1-9 passed in `test_v36_login_prefetch_logout_autoselect_duallink_e2e.mjs` |
| Permanent Logout & Tombstone | `store.js` | **VERIFIED** | Checks 10-16 passed in `test_v36` and `test_v28_auth_delete_newaccount_antibot.mjs` |
| Parallel Dual-Link Intake | `index.js`, `forwarded-order-flow.js` | **VERIFIED** | Checks 17-23 passed in `test_v36` and `test_v19_share_link_only_e2e.mjs` |
| Auto-Selection Only UX | `forwarded-order-flow.js` | **VERIFIED** | Checks 24-27 passed in `test_v36` |
| Single-Card UI & Clean Edits | `index.js`, `forwarded-order-flow.js` | **VERIFIED** | 100% passed in `test_v20_single_card_chat_e2e.mjs` |
| Real Swiggy Tracking & OTP | `order-tracking.js`, `swiggy-cart.js` | **VERIFIED** | 12/12 passed in `test_v26_real_tracking_and_delivered_links_e2e.mjs` |
| WAF Circuit Breaker | `waf-pool.js` | **VERIFIED** | 100% passed in `test_v34_waf_pool_breaker_e2e.mjs` |
| Accurate Order Count & 0-Order Detection | `swiggy-cart.js`, `account-vault-intake.js` | **VERIFIED** | Checks 1-14 passed in `test_v37_order_count_id_assign_choose_diagnostic_e2e.mjs` |
| Automatic ID Assignment & Account Selection | `index.js`, `forwarded-order-flow.js` | **VERIFIED** | Checks 15-16 passed in `test_v37_order_count_id_assign_choose_diagnostic_e2e.mjs` |
| ID Issues & Explicit Diagnostic Messages | `index.js`, `swiggy-cart.js` | **VERIFIED** | Checks 17-20 passed in `test_v37_order_count_id_assign_choose_diagnostic_e2e.mjs` |
| Order Count Display & Badge | `index.js`, `store.js` | **VERIFIED** | Checks 1-7 passed in `test_v38_accounts_logout_purge_order_count_display_e2e.mjs` |
| Complete Account Logout & Vault Purge | `index.js`, `store.js` | **VERIFIED** | Checks 8-15 passed in `test_v38_accounts_logout_purge_order_count_display_e2e.mjs` |

---

## 8. Known Bugs, Edge Cases & Unresolved Questions

1. **Unresolved Question - Live Payment Gateway Webhook:** Currently, Swiggy order payment is initiated via UPI Intent / QR or direct link; automated capture confirmation relies on customer pressing `[ I've Paid ]` or background tracking poller detecting order status transition on Swiggy's backend. Direct webhook integration with Swiggy gateway is not available without merchant API access.
2. **Edge Case - Shortlink Expiry:** Swiggy OneLink address share links expire after 24 hours. If an expired link is submitted, `resolveSwiggyLink` flags `unresolvableShortLink: true`, prompting the user for a fresh link or Telegram GPS location pin.
3. **Edge Case - Multi-Device Session Invalidation:** If a user logs into the Swiggy mobile app on a physical device and explicitly taps "Log out from all devices", the bot's stored `_session_tid` will be invalidated by Swiggy, triggering the WAF/Auth circuit breaker until a new `.json` session is dropped.

---

## 9. Security & Privacy Risks

- **Session Token Protection:** Swiggy session tokens (`tid`, `sid`, cookies) grant full access to ordering accounts. They are excluded from git via `.gitignore` and must never be committed.
- **PII Leak Prevention:** Customer delivery address and recipient mobile numbers are isolated in memory and DB drafts. Test suites enforce that customer order cards never leak other users' or ordering accounts' private mobile numbers.
- **Cloud Vault Encryption:** Cloud sync requires `GITHUB_VAULT_TOKEN`. If the token is omitted, cloud sync disables gracefully rather than failing or exposing credentials.

---

## 10. External Dependencies & Integration Limitations

- **Telegram Bot API:** Dependent on Telegram MTProto/Bot API rate limits. Single-card architecture prevents hit limits on message dispatch.
- **Swiggy DAPI / MAPI Endpoints:** Private, undocumented endpoints (`/dapi/...`, `/mapi/...`) subjected to Akamai / Cloudflare bot protection. Handled via session rotation, mobile user-agent spoofing, and WAF pool breaker.
- **Node.js Environment:** Requires Node.js >= 18 with ES module support (`type: "module"`).

---

## 11. Regression Risks & Verification Protocol

- **Risk:** Modifying message handler in `index.js` can accidentally re-introduce multi-bubble spam.
  - **Mitigation:** Run `test_v20_single_card_chat_e2e.mjs` before committing changes to message dispatcher.
- **Risk:** Altering account selection can re-introduce manual account chooser buttons.
  - **Mitigation:** Run `test_v36_login_prefetch_logout_autoselect_duallink_e2e.mjs`.
- **Risk:** Changes to session parsing might break older JSON vault formats.
  - **Mitigation:** Run `test_v15_zero_otp_cart_and_bulk_json_vault_e2e.mjs`.

---

## 12. Next Actions

1. Maintain `PROJECT_STATUS.md` on every code change as mandated by the Project Engineering Protocol.
2. Await user prompt for new features, bug investigations, or operational improvements.
3. Apply Protocol Rules 1–10 strictly to all future modifications.
