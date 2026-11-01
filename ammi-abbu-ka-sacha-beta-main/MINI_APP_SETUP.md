# Telegram Mini App and experimental checkout

Private chat collects the Swiggy cart and address links; the Mini App handles ID choice, fetched address, cart, bill and Pay Now. Existing chat orders and drafts remain available. Telegram-signed `initData` is required for the APIs; a regular browser can only preview the shell. The bot does not ask users to send OTPs, cookies, tokens or session files in chat.

**Checkout is experimental and enabled by default unless blocked by server settings.** Swiggy's private API shapes, order placement, UPI deep links, payment verification, OFO, tracking and Swiggy's own recipient SMS have **not** been verified in a live transaction here. Offline tests are not proof of a real order. Do not report success unless the actual provider response and device check establish it.

> Older round-by-round notes below describe historical screens. The current Tools screen omits the Live Order/SMS, data backup, backup check and login-data cards; the underlying backup and data functionality has not been deleted. Order details show a share link only when the provider returns one.

## Shared-ID access

All authenticated Telegram users can select every operator-uploaded ID by default, including IDs uploaded in the future. This is broad access, not a private-by-default family list. Boss can use **Tools → ID access** to revoke or restore a specific known user's access to an ID; a user appears in the manager after contacting the bot. IDs added by non-operators remain private to their own encrypted workspaces. Shared sessions and OTPs remain restricted; users cannot export, remove or claim operator accounts. Revocation stops new use but preserves the original account for an already-submitted checkout's status and recovery.

Both link collection and explicit access denials are stored in local `db.json` on `DATA_DIR`. They are **not included in the current cloud snapshots**: if this database is lost or rolled back, denials can be lost and default access restored, and users may need to resend links. Use private persistent storage and preserve the existing database, workspaces and placement journal. If an access write or fsync fails, the current process blocks that user/ID and reports failure, but a restart after an unpersisted denial may restore access. Do not assume cloud restore has been verified. Access and cart locks assume one application instance.

## Telegram's native Open / Open App buttons

The blue **Open** button in Telegram's chat list and **Open App** on the bot profile are Telegram's **Main Mini App** entry points. They are not created by an inline keyboard or `setChatMenuButton`. The Telegram account that owns the bot must enable them:

1. Open the official [@BotFather](https://t.me/BotFather) in Telegram, send `/mybots`, and select the existing Ammi/Abbu bot.
2. Choose **Bot Settings → Configure Mini App → Enable Mini App** (or the equivalent Main Mini App settings in the BotFather Mini App).
3. When asked for the URL, enter the deployed public HTTPS URL ending in `/pro`. The repository's keep-alive workflow references `https://ammi-abbu-ka-sacha-beta.onrender.com`, so its candidate is `https://ammi-abbu-ka-sacha-beta.onrender.com/pro`; first confirm that this is the active service for the selected bot. The public shell alone does not establish that the server is configured with that bot's token or that signed Telegram sessions work.
4. Open the bot profile and tap **Open App**. Check the chat list for **Open** as well; exact presentation can vary by Telegram client/version. If needed, update or restart Telegram. Test with a real Telegram user, not just a browser preview.

The **Open** button beside the chat message field is a separate private-chat menu button, not the Main Mini App setting. In @BotFather send `/setmenubutton`, select the same bot, give the confirmed HTTPS `/pro` URL, and enter `Open` for the button text when prompted. Telegram client layouts may vary. Alternatively, after this version is deployed, setting `PRO_MINIAPP_URL` to the same URL makes the bot configure that menu on startup; `/pro` also opens the app. Neither method enables the profile/chat-list buttons. When the variable is absent or invalid, the bot leaves a manually configured menu unchanged. Use the host's secret settings for the bot token; never send it or OTPs in chat.

## Hosting and configuration

1. The checked-in `render.yaml` describes a **worker**, not an HTTPS web service. The dashboard may also contain a separately configured web service; verify which service actually serves `/pro` and `/pro/api/*`, whether it runs the same bot, and whether it has persistent storage. If there is no suitable service, a migration to a publicly reachable HTTPS **web service** running this process and exposing its assigned `PORT` is needed. That migration has not been tested. Do not run an old worker and a new web service simultaneously with the same Telegram bot token: both would compete for updates. The repository's Render deployment follows `main`, so changes on an unmerged branch are not automatically deployed there.
2. Configure the existing bot secrets through the host's secret manager and set `PRO_MINIAPP_URL` to the real public HTTPS URL ending in `/pro` for `/pro` and the in-chat menu. Use the same URL in BotFather's Main Mini App settings for the native profile/chat-list buttons. The URL must be reachable on the user's phone. Telegram accepts only HTTPS Mini App URLs. Do not put credentials or OTPs into this document, Git, or chat.
3. Set a strong, stable `PRO_VAULT_KEY` (at least 16 characters); `VAULT_ENCRYPTION_KEY` is used only if it is absent. Mini App workspaces are AES-256-GCM encrypted separately per Telegram user under `DATA_DIR/pro-workspaces`. Losing or changing the key makes existing workspaces unreadable. Back up the key securely and back up the encrypted files separately. If no key is configured the server manages a stable one itself (see the section below); the app never dead-ends on a missing key. Shared (boss-uploaded) IDs live in the bot account vault, not in a user's workspace; the Mini App only ever decrypted server-side and never sends a token to the client.
4. Set `DATA_DIR` to **private, persistent storage**. Preserve both `pro-workspaces` and `swiggy-placement-journal`, plus the bot's existing order/account data. Losing or rolling back either directory can defeat the duplicate-order barrier. The journal must be on the same durable filesystem visible to every process that can submit the *same logical checkout*; it uses exclusive creation and fsync. Run **one application instance**: workspace and account locks are in-process, and multiple replicas can overwrite workspace/cart state even when the journal is shared. Do not use ephemeral/serverless local storage or run the separate `bossbot` engine alongside this service on the same order/account. Take consistent encrypted backups; never restore an old snapshot over newer unresolved placement records.
5. In-app UPI checkout is **ON by default** since 31-10-2026 (boss: "actual payment flow apply kar"). Set `PRO_ENABLE_CHECKOUT=0` to turn the happy path off on a service; leave it unset for normal operation. `SWIGGY_BLOCK_LIVE_ORDER_PLACE=1` is the hard block and overrides everything (chat and Mini App placement alike) — remove that block only for an agreed real test. Restart the single service and verify `/pro` inside Telegram. The deployed version and device compatibility must be checked independently.

## Fix the Mini App vault error safely

The message “Mini App vault is not configured” appears **before** an OTP request is sent. It means the active `/pro` server cannot find a sufficiently long vault key; changing the phone number will not fix it.

1. In Render, identify the **web service actually serving the public `/pro` URL**, not just the worker in `render.yaml`. Check its Environment settings and any linked environment group privately. Identify the persistent `DATA_DIR` and preserve its `pro-workspaces` and `swiggy-placement-journal` directories.
2. **If encrypted workspaces already exist or might need recovery**, restore the exact existing encryption key from the trusted service configuration or a secure backup. Never generate a replacement just to dismiss the error. The app uses a non-empty `PRO_VAULT_KEY` in preference to `VAULT_ENCRYPTION_KEY`; a new or incorrect `PRO_VAULT_KEY` overrides the old fallback and makes existing workspaces unreadable. If the original key was the fallback, remove the incorrect override and restore the original fallback value. If the key is lost, preserve the files and investigate backups; there is no safe reset that recovers them.
3. **Only if no existing encrypted workspaces need to be recovered**, create a new strong random secret (for example, 32 random bytes encoded as 64 hex characters) and set it as `PRO_VAULT_KEY` on that service. Back it up securely, separately from the encrypted data. Do not paste the value, any OTP, bot token or session into chat or commit them to Git.
4. Save the environment change and redeploy/restart that one service. Open the app from Telegram and retry. The improved retry/error screen in this branch appears only after these code changes are deployed. A successful bootstrap does not by itself verify OTP delivery or real checkout.

## Checkout behavior and limits

* Resolve/select the receiver and check name, phone, street and map location. For a different receiver, OFO fields are sent but the provider may not echo an OFO flag; the current path can still place an order and reports OFO as unconfirmed. This does **not** prove that Swiggy will send an SMS. The bot does not send a recipient SMS, including payment-link SMS.
* Syncing replaces the selected account's Swiggy cart and may save the address. The app independently reads back the saved address and cart, checks item IDs, quantities, variants/add-ons and address, then displays the provider's bill. Direct menu customization, card/COD checkout, manual map pinning and automatic offer selection/claiming are not implemented.
* After reviewing a bill less than five minutes old, the user explicitly confirms the account, receiver and exact amount. Checkout requires a saved Swiggy customer ID so recovery can stay tied to that account; reconnect the account first if its identity is missing. The provider adapter rechecks the live cart, OFO marker, recipient and exact paise, then attempts **one** Swiggy placement POST. A QR is generated only from a UPI intent actually returned by that response, with the exact approved amount and an order ID. No merchant URI or success is invented. Mini App checkout currently supports only the UPI amount returned by this path; other payment/split methods require the official Swiggy app.
* A successful gateway response alone is not an accepted order. Status checking uses the original account, the exact order ID and a provider-reported payment/order state. QR details are hidden once payment is reported, even while order confirmation remains pending. Tracking is fetched only for an order in that account's history. UPI app handoff inside Telegram varies by device; the link is best effort and a second device may be needed to scan the QR. This has not been tested on a real device.
* This filesystem barrier is **not Swiggy-provided idempotency**. It protects repeated attempts for the same journaled chat order or Mini App checkout generation on that disk; it cannot prevent a user from manually placing another order, submitting a separate chat/Mini App order, using another deployment or losing/rolling back the journal. Never place the same order simultaneously through another client.

## Unknown outcome or recovery

If a request times out, returns no valid payment intent, the server restarts while submitting, or the browser loses the result, **an order may already exist**. Do not retry, switch accounts, refresh/replace the cart, pay twice or claim that the order was cancelled. The app locks draft-cart/receiver changes and account switching while a checkout is unresolved; reconnecting is permitted only for the verified original account. If an older unresolved checkout has no recoverable customer ID, reconnecting stays blocked rather than guessing; preserve the data and investigate. The in-app checkout-history button also uses that original account, including in older workspaces where another account was selected. An empty or delayed order list does not prove failure. Check **My Orders on the original Swiggy account** and its payment history. If an exact order ID is known, use the status check; only a verified paid order can be explicitly closed to start a new Mini App draft. A `SUBMITTING`/unknown state with no order ID stays blocked across restarts; there is deliberately no automatic expiry or reset. Keep the journal and workspace intact and seek operator-assisted investigation before any separate order.

## Offline tests and authorized live trial

```bash
npm ci --ignore-scripts
npm run test:pro
npm test
```

`test:pro` uses fake providers and fault-injected Swiggy-shaped HTTP responses. It checks Telegram authentication, isolation, exact cart/recipient/amount, a single POST under concurrent taps, timeout/restart replay, account failover guards, QR contents, payment/order mismatch and tracking ownership. It does **not** verify Swiggy's real private API or SMS.

A real trial requires a suitable deployed HTTPS service with persistent storage, an account controlled by the user, an actual receiver, and a real device. First verify login, link autofill, cart/bill and recipient in Swiggy without paying. Only after the user explicitly confirms the actual account, recipient, exact amount and that a real paid order is authorized should anyone submit it. Record the genuine result in Swiggy, payment app, and on the recipient's phone. Never ask the user to post OTPs, credentials or session tokens in chat.

## Shared IDs, privacy and update-safe data (31-10-2026)

* **Operator (Boss) IDs are shared by default; user IDs are private.** Every authenticated Telegram user can select operator IDs unless Boss explicitly revokes that ID for that user. An account a normal user adds with OTP or JSON stays in **that user's own encrypted workspace** and is never listed for anyone else or written into the shared vault.
* **Shared credentials remain restricted.** Account tokens, cookies and sessions do not appear in the normal account list or bootstrap response. The JSON export endpoint deliberately returns a session only to its owner, or to Boss for a Boss ID; other users cannot export operator sessions. On an operator ID the full phone number is masked for normal users. A shared ID cannot be removed or claimed by a normal user (`canRemove`/`canClaim`).
* **Used IDs warn, then allow.** A used ID (orders already placed on it) returns `409 ACCOUNT_NEEDS_CONFIRM`; the app shows an in-app warning and only selects it after the user confirms (`confirmUsed: true`). Suspended, expired and busy (live order) IDs stay blocked.
* **Privacy of order history and addresses.** On an accessible shared operator ID a normal user gets a compact order card without the item list or address; the operator's saved address book is not shown. A Swiggy-provided share link, when available, does not expose delivery OTP or address through this API. Boss sees full details.
* **Navigation and payment.** The main account, address, cart and order screens stay in the Mini App. A returned UPI intent can open a payment app, and Telegram's share sheet can open for a genuine share link. Do not assume either flow has been verified on a device.
* **Bill breakdown** mirrors Swiggy: item total, delivery fee (`FREE` when zero), GST & other charges, coupon saving and **To Pay**. A positive unexplained difference is surfaced as `otherCharges`; a total *below* the listed lines is treated as an unlisted Swiggy discount (`unlistedDiscount`) and shown as a saving line. The old "lines aur total me farak hai" warning box is gone for good (boss rejected it on 31-10-2026).
* **Preserving data across updates.** Use persistent storage and preserve the database, workspaces and placement journal; an update or ephemeral disk is not by itself proof of recovery. When configured, encrypted workspace snapshots can be backed up to `vault/pro-workspaces/<hash>.json` on the `bot-vault` branch (set `PRO_VAULT_CLOUD_BACKUP=0` to opt out). Restore is not verified here, and link drafts and access denials are not included in the current cloud snapshots. The browser keeps non-secret UI state such as theme, last tab and remembered ID names; it does not restore account sessions or carts.

## Cart, claims and delete (31-10-2026, round 2)

* **Cart page** now follows the Swiggy cart layout: group-cart link, "Delivering to", "Your Order" with item steppers, "Apply coupon" (expands to the coupon + bill form), "Bill Details", and "Payment Method". Only **UPI / QR** is real; card and cash-on-delivery are shown disabled with an honest reason. The "Pay Now" bar appears when a fresh Swiggy bill exists and runs the real checkout by default (`PRO_ENABLE_CHECKOUT=0` opts out, `SWIGGY_BLOCK_LIVE_ORDER_PLACE=1` hard-blocks).
* **Progress + skeletons.** Every in-app request shows a thin top progress bar, buttons show a spinner, and the page that is loading shows skeleton rows instead of an empty screen. Menu opening and restaurant search have their own returning skeletons.
* **Offers are claimable in the app.** Tools lists every offer track (late night, breakfast, extra ₹50, weekend, Karwa Chauth) per account with the honest state, and a claim button runs the same verified `activateAllEventOffers` path the bot uses: read state first, write once, read back, never claim twice. Results are stored on the account so the icons (claimed ✓ / not claimed struck-through) survive a reload. **Operator IDs cannot be claimed** (`403 SHARED_ACCOUNT_RESTRICTED`).
* **Delete has two separate options.** "Database se hatao" only removes the ID from this app/vault. "Swiggy se delete" asks Swiggy for its **delete OTP**, and only after that 6-digit OTP is verified does it remove the account — locally and at Swiggy. A wrong OTP leaves the account untouched. Operator IDs can never be deleted by a normal user. Swiggy deletion is irreversible; no backup file is sent from the Mini App.
* **Restaurant locations and dish search.** Search results show one row per outlet with a "N locations" pill, the menu page lists the other outlets of the same restaurant as chips, and the menu has its own dish search that filters instantly.
* **No admin/support button.** The Mini App no longer opens a Telegram DM or any external link.

## Cart parity with Swiggy + real payment (31-10-2026, round 3)

* **Payment is real by default.** `checkoutEnabled()` in `swiggy-pro-api.js` returns `true` unless `PRO_ENABLE_CHECKOUT=0` or `SWIGGY_BLOCK_LIVE_ORDER_PLACE=1`. `/pro/api/bootstrap` now returns `checkoutEnabled` **and** `checkoutBlockReason`, so when payment really is blocked the app shows the actual reason instead of a silent "band hai". The `Pay Now` band is a live green button whenever a fresh bill exists.
* **Cart header matches Swiggy.** Restaurant thumbnail, name, area · ETA, and a trash button (`cart-clear`, confirm-first) sit where Swiggy puts them. Item rows carry a veg/non-veg mark, the green quantity stepper and the line total.
* **Franchise / multiple outlets.** Each cart row has an outlet row (`outlets-toggle`): it shows the current area + ETA and expands into nearby branches from `GET /pro/api/restaurants/outlets?q=<name>`, each with area, distance, ETA and open/closed state. Closed branches and the current branch are disabled; picking another branch opens that outlet's menu.
* **Group cart is a toggle**, not an always-open form.
* **Bill maths is honest and quiet.** `itemTotal`, `deliveryFee` (`FREE` when 0, with the delivery distance), `GST & other charges` and `To Pay` add up; the two reconciliation fields are `otherCharges` (positive gap) and `unlistedDiscount` (total below the listed lines). `mismatch` is always `false` — no warning box.
* **New/changed routes:** `POST /pro/api/cart/clear` (`{confirmClear:true}`) and `GET /pro/api/restaurants/outlets?q=`. `cart/sync` now also stores the restaurant's area/ETA/image/rating from the open menu so the cart header survives a reload.
* **Tests:** `test_v94_miniapp_cart_parity.mjs` (9 offline checks: payment default/opt-out/hard block, outlet list, confirm-gated clear, cart meta, cart DOM, outlet dropdown, group-cart toggle, disabled-payment reason, CSS hooks). `test_v93` now asserts the `unlistedDiscount` behaviour instead of the removed `mismatch` warning.

## Shared IDs, privacy and update-safe data (31-10-2026, round 4)

* **Shared ID access (updated):** `accountMap(user, ws)` default se Boss ke vault IDs aur user ke private workspace ko jodta hai, per-user explicit denials ko chhodkar. Shared ID ka number masked rehta hai aur `canClaim: false`, `canRemove: false`; token client ko nahi jaata. User ka apna ID sirf usi ko dikhta hai.
* **Used ID: pehle warning, phir select.** `POST /pro/api/accounts/select` `409 ACCOUNT_NEEDS_CONFIRM` deta hai jab ID par pehle order ho chuke hain; `{ confirmUsed: true }` ke baad wahi ID select ho jaati hai. `BUSY` (kisi chalte order ki ID), `SUSPENDED` aur `SESSION_EXPIRED` confirm ke baad bhi band rehti hain. App pehle in-app dialog dikhata hai, seedha call nahi karta.
* **Address privacy.** Shared ID par `GET /pro/api/addresses` saved address list **khaali** lauta kar ek note deta hai — doosre logon ke address kabhi nahi dikhte. User apna address link se add karta hai (uske workspace me rehta hai). Boss ko poora list dikhta hai. Fetch do baar try karta hai (350 ms gap) aur uske baad hi error deta hai, taaki ek transient Swiggy failure "address nahi mila" na bane.
* **Order history.** Shared ID ke orders normal user ko chhote card me (id, restaurant, status, amount, date) milte hain; `orders/tracking` par `403 SHARED_ACCOUNT_RESTRICTED`. Boss ko items, address aur tracking sab dikhta hai.
* **Update se data reset nahi.** Workspace schema sirf naye fields add karta hai aur failed request par file delete nahi karta. Encrypted blob per user `DATA_DIR/pro-workspaces` me rehta hai; `PRO_VAULT_CLOUD_BACKUP` (default on, `=0` se off) se wahi blob cloud vault me bhi jaata hai aur fresh disk par pehle read se pehle wapas aata hai (`ensureProWorkspaceHydrated`). Browser me sirf non-secret UI state (`pro-state-v2`: tab, theme, pehle dikhi ID ka naam) rehta hai — redeploy par khaali screen ki jagah "re-login needed" reminder.
* **App ke andar hi sab.** Koi browser link, `target="_blank"`, ya `window.open` nahi — tracking bhi app me dikhti hai. Sirf `upi:` intent (payment) allowed hai — Swiggy/BotFather ka koi link app me nahi hai.

## Checkout page + outlet picker (31-10-2026, round 5)

* **Checkout page Swiggy jaisa.** Cart tab ab `CHECKOUT` page hai: ETA strip ("Delivery in 25 min" + restaurant + "Deliver to HOME") → address tile → "Your Order" (restaurant head, items, steppers, add more) → group-cart toggle → "Apply coupon" → "Bill Details" → "Payment Method" → sticky **Pay Now** bar. Section order is asserted in `test_v93`.
* **Pay Now always live.** Bill na ho to button phir bhi dabta hai: pehle `cart/sync` se taaza Swiggy bill aata hai, phir ek Hinglish confirm dialog (`Pay ₹335 — order confirm?` with restaurant, receiver, full address) aur phir asli `POST /pro/api/checkout`. Ek hi tap me order confirm nahi hota, par koi dead end bhi nahi.
* **Restaurant kholne par outlet chunna.** Search results me same naam ke >1 outlet ho to row dabane par Swiggy jaisa bottom sheet (`CHOOSE LOCATION`) aata hai — har branch ka area, distance, ETA aur open/closed. Band branch disabled, current branch "Yahi". Ek hi outlet ho to seedha menu. Menu page par bhi outlet row ("25 min · Outlet badlein") wahi sheet kholta hai.
* **Tracking app ke andar.** `target="_blank"` / `window.open` / browser link hata diye gaye; status, ETA, partner aur OTP app me hi dikhte hain.
* `test_v93` (20 checks) aur `test_v94` (13 checks) in dono pages ko lock karte hain.

## Group cart parsing + backup truth (31-10-2026, round 6)

* **Koi dropdown nahi.** Cart page par group cart ka link box aur **"Cart parse karein"** button hamesha saamne hain (`form[data-form="group-cart"]`). Input `type="text"` + `inputmode="url"` hai taaki `swiggy://` deep link bhi paste ho sake. Khaali box par seedha message aata hai, request nahi jaati.
* **5 link shapes parse hote hain** (`extractGroupCartRef` / `resolveGroupCartLink` in `swiggy-pro-provider.js`):
  1. `https://www.swiggy.com/gc/<x>/<slug>-<cartId>` (web share)
  2. `https://www.swiggy.com/gc/<cartId>` (chhota link)
  3. `?sharedCartId=` / `?groupCartId=` / `?shared_cart_id=` query links
  4. `swiggy://gc?shared_cart_id=…` aur `swiggy://share?text=<encoded url>` deep links
  5. `swig.gy` / `swiggy.onelink.me` short links (redirect expand karke)
  URL-encoded link bhi khulta hai. Kuch match na ho to saaf wajah + jo format chahiye wo message me aata hai; jhootha cart id kabhi nahi.
* **Backup ab do jagah, aur sach dikhta hai.**
  * **DB mirror:** har workspace ka *encrypted* envelope `db.json` → `config.proWorkspaceMirror` me (debounce 1.5 s, max 300 rows, checksum ke saath). Koi token nahi chahiye.
  * **Cloud vault:** `vault/pro-workspaces/<hash>.json` (`GITHUB_VAULT_TOKEN`/git hone par).
  * Restore: local file na mile to pehle cloud, phir DB mirror (`ensureProWorkspaceHydrated`), aur `backup.restored` me `lastFrom` + count aata hai.
  * **Boss ko Tools me "Data backup" card**: mirror rows, last save time, cloud ON/OFF, cloud ki asli error, kitni baar restore hua, aur **"Abhi backup karein"** button (`POST /pro/api/backup`, sirf boss).
  * `GET /pro/api/bootstrap` ab `backup` field deta hai — boss ko poora, user ko sirf mirror ki haalat.
* **Tests:** `test_v95_miniapp_cart_import_and_backup.mjs` (11 checks: 7 link shapes, galat link par asli error, short-link expansion, mirror→restore, backup status/route permissions, no-dropdown DOM, parse request, khaali-link toast, boss backup card, user ko card nahi).

## Round 7 (31-10-2026): cart fetch, Swiggy-jaisa checkout, coupon page, tracking

* **Cart fetch ka asli fix.** Mini app sirf `GET /api/v1/shared_cart` karta tha, jisse doosre customer ka group cart `statusCode 86` (USER_ALREADY_PART_OF_GROUP_CART) ya khaali aata tha. Ab pehle bot ka proven engine chalta hai — `POST /api/v1/shared_cart/join` (ephemeral reader `user_id`) — phir read-only GET. Fail par HTTP status + Swiggy ka `statusCode`/`statusMessage` message me aata hai; band cart (`88` / GROUP_CART_NO_LONGER_EXISTS) aur place-ho-chuka cart ki alag saaf wajah.
* **Link shapes:** apna parser + `resolveSwiggyLink` fallback (AppsFlyer HTML, `swiggy://webviewV2?group_cart_id=…`, `af_dp`/`deep_link_value`). Address pin na ho to bhi cart parse hota hai (lat/lng sirf headers ke liye).
* **Navigation block khatam.** Global `state.busy` lock hata diya — sirf wahi button band hota hai jisne request bheji. Address load hote waqt bhi doosra tab turant khulta hai.
* **Cart/checkout page Swiggy jaisa:** ETA + "Deliver to", savings banner, Your Order card (rating, items, swiggy-style stepper), "Add Items / Apply coupon" chips, **Complete your meal** rail (isi restaurant ke asli menu se), **Savings Corner** (Applied/Remove), bill, payment method, aur pay bar: bada total + `View Detailed Bill` + green **Pay Now · Proceed to Pay**.
* **Coupon page** (`Apply coupon`): applied coupon ka ribbon (`₹140 OFF`, REMOVE), asli code se APPLY, aur Swiggy ke coupon tool (`fetch_food_coupons`) ki list — jo lagta nahi wo LOCKED + reason. List khaali aaye to saaf likha: "Swiggy ne list nahi di".
* **Route:** `GET /pro/api/coupons?id=<restaurantId>`; `restaurants/outlets` me ab `rating`/`ratings` bhi.
* **Pay → track:** Pay Now (bill na ho to pehle khud bill leke) → payment screen (QR + "Payment check karein") → `checkout/status` PAID → **tracking screen** (timeline, ETA, rider, delivery OTP) jo 20s me khud refresh hota hai. `orders/tracking` hi source hai — koi guess nahi.
* **Typing safe:** re-render par coupon code / group cart link ka typed text nahi udta.
* **Imaandaar:** payment band ho to pay bar ke neeche asli reason (`PRO_ENABLE_CHECKOUT=0` jaisa) dikhta hai, sirf tooltip nahi.

## Round 8 (31-10-2026): poora bill hisaab + coupon sirf APPLY

* **Coupon page: koi code type nahi — sirf APPLY.** Har coupon card par ek hi button. List kabhi khaali nahi: pehle Swiggy ke apne `fetch_food_coupons` ke coupons, phir wahi promo codes jo bot ka engine har order par test karta hai (`SNACKIT`, `TRYNEW`, `STEALDEAL`, `SWIGGYIT`, `WELCOME50`). "Coupon available nahi hai" jaisa message kabhi nahi aata.
* **APPLY = asli bill.** Dabate hi `cart/sync` chalta hai, aur card par wahin result likha aata hai: `Laga — ₹140 ki saving` ya `Swiggy ne is code par discount nahi diya — bill me 0 dikha`. Jhootha saving kabhi nahi.
* **Bill Details detailed:** Item Total (strike ke saath jab discount laga), Delivery Fee (+ distance), GST & Other Charges, Coupon, Offer saving, **To Pay** — phir `Poora hisaab dekhein` par har item (`× qty = ₹`) aur poora jod: `Items + Delivery + Packing + GST + Other − Coupon − Offer = To Pay`. Swiggy ka total hi final.
* **Checkout dead end gaya:** Pay Now / bill / coupon sabse pehle receiver check karte hain. Naam ya 10-digit mobile adhoora ho to app seedha **address page ke receiver form** par le jaata hai (pehle API error aata tha aur user ko lagta tha checkout kharab hai). `customer_id` kisi purane session me na ho to bill sync ke waqt app ek baar Swiggy se identity le kar save kar leta hai (order placement ka double-tap barrier waisa hi rehta hai).
* **Test:** `test_v97` (6 checks) + v90/v93/v96 updated. Sweep: `test:pro` 40/40, `test:guards` 65/65, `npm test` 132/132, bossbot 49/49.

## Round 9 (31-10-2026): bill summary bilkul Swiggy jaisa

Boss ka example: `Items Total ₹230 · Coupon FLASHSALE −₹160 · Extra Discount (Free Cash) −₹70 · Swiggy One Lite Membership +₹1 · Free Delivery ₹49 saved · Packing ₹5 · GST & Other ₹27.85 · Total Savings ₹279 · To Pay ₹29`.

* **Provider (`quoteCart`)** ab Swiggy ke parsed cart se yehi fields bill me bhejta hai: `itemTotal, deliveryFee, deliverySaved, deliveryFree, packingCharges, taxes, discount + coupon, freeCash, tradeDiscount, oneMembershipFee, oneApplied, totalSavings` — aur `total` wahi `meta.order_total` (jo Swiggy charge karta hai; checkout isi se match karta hai).
* **`billBreakdown`** ab `free cash` / `tradeDiscount` / `One fee` ko jod me leta hai; jo bacha wo `otherCharges`, jo kam pada wo `unlistedDiscount` (bill me "Extra saving (bill me)" line). Isliye lines ka jod **hamesha To Pay ke barabar** hota hai — koi darawne warning nahi.
* **Bill Details card** me lines: Items Total · Coupon X · Extra Discount (Free Cash) · Extra Discount (Restaurant) · Swiggy One Lite Membership (+) · Free Delivery (+ kitna saved) · Delivery Fee FREE (₹49 saved) · Packing Charges · GST & Other Charges · Extra saving · **Total Savings** · **To Pay**. `Poora hisaab dekhein` par item-wise lines + pura equation.
* **Savings Corner** me wahi rows (Coupon/Free Cash/Restaurant/Free delivery/One Lite fee) + `₹279 saved` pill, aur **banner** me Swiggy ka khud ka `totalSavings` (apna bada number nahi banate).
* **Test:** `test_v98` (2 checks, boss ka exact ₹230 → ₹29 case) — lines ka jod To Pay se match, jhootha saving nahi. Sweep: `test:pro` 40/40, `test:guards` 66/66, `npm test` 132/132, bossbot 49/49.

## Round 10 (31-10-2026): Pay ki asli wajah + naye number ka login

### "Swiggy cart, recipient/OFO, coupon or amount could not be confirmed"
Pehle **ek hi generic line** thi — user ko pata hi nahi chalta tha kya badla. Ab `provider.checkout` har check alag karta hai aur message me **dono numbers** aate hain:

| Code | Matlab | Kya hota hai |
|---|---|---|
| `CART_FETCH` / `CART_PARSE` / `CART_ID` | Swiggy ne cart/jawab/cart-id nahi diya | Order nahi, asli HTTP+statusCode message |
| `CART_ITEMS` | Swiggy ke cart me items badal gaye | Order nahi, "cart sync karein" |
| `RESTAURANT` / `ADDRESS` / `OFO` | restaurant, address ya OFO flag alag | Order nahi, saaf wajah |
| `AMOUNT` | bill ka amount badal gaya | **Order nahi** + **naya bill save** + "aapne ₹29 dekha, Swiggy ab ₹33.85 keh raha hai" |
| `COUPON` | coupon lag/hat gaya | **Order nahi** + naya bill + dono coupon naam |

* Recoverable case (`AMOUNT`/`COUPON`) me API **naya bill workspace me save** karta hai aur 409 `BILL_CHANGED` deta hai. App bootstrap karke naya total dikhata hai — user ek baar dekh kar dobara Pay dabata hai. Koi loop nahi, koi galat amount ka order nahi.
* App ab in codes par **"outcome unknown"** ka darr nahi dikhata (pehle har error par dikhta tha, jabki kuch place hi nahi hua tha).
* `cart/sync` ab `quote.couponCode` bhi save karta hai (bill me discount item-total me hone par bhi asli coupon compare hota hai).
* Items compare tolerant hai: group-cart ke raw variants/add-ons shape alag hone par bhi `item+qty` match ho to order rukta nahi; sirf sach me badla ho tab rukta hai.

### Naya number = login hi nahi hota
* `POST /accounts/send-otp` ab `signup: true` leta hai. Bina consent Swiggy account nahi banta; app pehle poochta hai **"Naya Swiggy account banayein?"** (naam + number dikha kar), phir signup ke saath OTP maangta hai. Pehle seedha "not registered" error aata tha — dead end.
* **30-second cooldown bug:** naya number par "account banayein" dabane ke baad bhi 30s tak retry block tha (cooldown fail par bhi set ho raha tha). Ab cooldown sirf success par lagta hai.
* `verify-otp`: brand-new account par Swiggy ka profile kabhi `customer_id` nahi deta → account save hi nahi hota tha. Ab OTP-verified session ke JWT se **asli** `user_id` liya jaata hai (koi invent nahi). Sirf jab wahan bhi na mile to saaf error.
* Error JSON me ab `code` aata hai (`SWIGGY_ACCOUNT_NOT_REGISTERED`, `OTP_IDENTITY_MISSING`, `BILL_CHANGED`, …) — app usi se sahi agla kadam dikhata hai.

## Round 11 (31-10-2026): OFO ka jhootha block, auto coupon bill, wallet ₹15 + UPI

### 1. "Swiggy ne order for someone else flag confirm nahi kiya" — ye block hata diya
Swiggy ka cart readback (jisse hum bill banate hain) OFO flag **deti hi nahi**, isliye `cart.forSomeoneElse` wala har order `OFO` hard-stop par ruk jaata tha — order jaata hi nahi tha. Ab:
* `OFO` ab **hard stop nahi** hai (problems list se hata diya, `hardStop` se bhi).
* OFO ka sach sirf **place-response** se aata hai: `result.ofoConfirmed` (jhooth nahi) + `result.ofoNote` (Hinglish me saaf: "Swiggy ne place-response me OFO flag nahi diya — order normal order ki tarah gaya, khana usi address par jayega").
* OFO fields (recipient name/phone, alternate_mobile, delivery instructions) ab bhi cart aur place payload me jaate hain — bas unka echo na aana order nahi rokta.

### 2. "AUTO SAARE COUPON LAG KAR AISA SUMMARY NAHI AARHA"
* `provider.quoteCart(account, address, cart, '')` — jab user ne koi code na chuna ho aur `cart.autoCoupon !== false` ho, provider Swiggy ke coupons (MCP `fetch_food_coupons` + promo list) se **top 3** codes try karta hai, har attempt ka **asli bill** padhta hai, aur **sabse kam total** wala coupon rakhta hai. Saboot bill me: `autoCoupon: true`, `couponTried: [...]`.
* User ne code chuna ho to wahi chalta hai (auto band). `Remove` dabane par `autoCoupon: false` jaata hai — jaan-boojh kar hataya hua coupon wapas nahi lagta.
* **Puraana bug:** Pay Now aur `bill-refresh` dono `coupon: ''` bhejte the — yani jaan-boojh kar coupon hata kar naya bill le rahe the. Ab dono **pehle se laga coupon** bhejte hain + `autoCoupon: true`.
* **Automatic bill:** cart kholte hi (items + poora receiver hone par) app khud `cart/sync` karta hai — Pay dabane ka intezaar nahi. Ek hi baar per cart+address (loop nahi), aur receiver adhoora ho to bilkul nahi.
* **Bill ka plain text:** `billText()` bilkul Swiggy ke summary jaisa organized block deta hai (`Paneer Kolhapuri ₹230 × 1 = ₹230` → `1 Item • Subtotal: ₹230` → `Bill Summary` → `Items Total` → `Coupon FLASHSALE: −₹160` → `Extra Discount ( Free Cash ): −₹70` → `Swiggy One Lite Membership: +₹1` → `Free Delivery upto 7km` → `Delivery Fee: FREE (₹49 saved)` → `Packing Charges: ₹5` → `GST & Other Charges: ₹27.85` → `────────` → `Total Savings: ₹279` → `To Pay: ₹29`). Card me `<pre class="bill-plain">` ke roop me dikhta hai. Koi number invent nahi — jo Swiggy ne diya wahi.

### 3. Wallet: ₹15 fee + UPI top-up (`mius@ybl`) + jitna bheja utna credit
* **Gate:** order place karne se **pehle** wallet me fee (default **₹15**) chahiye. Balance kam ho to `409 WALLET_LOW_BALANCE` + asli message: "Wallet balance ₹0 hai — order place karne ke liye ₹15 chahiye. ₹15 add karein (UPI: mius@ybl)" + `wallet` payload (balance/shortfall/upiId). Bill dekhne par kuch nahi rukta.
* **Fee kab katti hai:** checkout start hote hi (QR/order stage) `chargeServiceFee` — ek order par ek hi baar. Order place **na** ho (pre-placement failure / `BILL_CHANGED`) to `refundServiceFee` se **fee wapas**.
* **Routes:**
  * `GET /pro/api/wallet` → balance, fee, exempt, ready, shortfall, `upiId`, presets, history.
  * `POST /pro/api/wallet/topup {amountPaise|amountRupees}` → asli `upi://pay?pa=mius@ybl&am=15.00&cu=INR` intent + PNG QR (Telegram ke andar hi dikhta hai).
  * `POST /pro/api/wallet/claim {amountRupees, utr?}` → **jitna user kehta hai ki usne bheja, utna hi credit** (boss: "IF USER PAY LESS AND SAY I HAVE PAID YOU HAVE TO ADD HOW MUCH THEY PAID"). Ledger me `CLAIMED`, audit ke liye `db.config.topupClaims`. UTR diya aur provider configured hai to `AUTO_VERIFIED` (jhootha verified nahi). Response me seedha: "₹10 jama hua. Abhi balance ₹10 hai — ₹5 aur add karein."
  * `POST /pro/api/wallet/upi {upiId}` → **sirf boss**. Default `mius@ybl`; `WALLET_UPI_ID` env se bhi.
* **UI:** cart aur tools tab me **Wallet card** — balance, fee, "Low balance" pill + kitna add karna hai, ₹15/₹50/₹100 quick buttons, QR + "UPI app me ₹15 bhejein", aur **"Paisa bhej diya?"** form (amount + optional UTR). Boss ko `UPI badlein` ka option bhi wahi card me.
* **Tests:** `test_v100_miniapp_wallet_ofo_autobill.mjs` (14 checks) — OFO soft (order jaata hai, `ofoConfirmed:false`, note sach), auto coupon (best total, `couponTried`), `cart/sync` me `autoCoupon`, wallet default UPI/fee/low balance, ₹10 → ₹5 → ready, topup QR `pa=mius%40ybl`, boss-only UPI change, `WALLET_LOW_BALANCE` par provider tak baat nahi, fee charge + refund, bill text ki exact lines, auto bill.
* `test_v89` (7) aur `test_v88` (41) update kiye — OFO flag ab blocking nahi, aur checkout tests wallet funded karte hain.
* Sweep: `test:guards` **68/68 (126s)**, `test:pro` **41/41**, `npm test` **132/132**, DOM v90/v93/v94/v96/v97/v98 **58/58**, v99 **7/7**, v100 **14/14**.

## Round 12 (31-10-2026): QR na aana, forwarded address bind, UTR auto verify

### 1. "QR NAHI AYA PAYMENT KA AISA HO GAYA"
Asli case: Swiggy ne order **accept** kar liya (`order_id` mil gaya) par QR/intent nahi mila → app `OUTCOME_UNKNOWN` me chala jata tha aur QR kabhi nahi dikhta tha.
* **Intent extraction ab poore jawab me dhoondti hai** (jaisa bot karta hai): `app_redirection_info` ke saath `payment_fallbacks`, nested `order_data`, aur JSON text me escaped `upi:\/\/pay?...&amp;` bhi decode hota hai. Pehle sirf ek structured field dekha jata tha — wahi QR na aane ki wajah thi.
* **Order bana par QR nahi mila** → ab alag, saaf haalat: checkout `PAYMENT_PENDING` + `qrMissing: true` + `qrMissingReason` + `orderId` (plus Swiggy ne koi payment page link diya ho to `paymentPageUrl`). Koi jhootha QR nahi, koi naya order nahi.
* **QR ka amount bill se match na kare to wo QR kabhi nahi dikhaya jaata** — wajah saaf ("QR ₹99, bill ₹70").
* App me card: *"Swiggy ne order le liya par payment QR nahi diya"* + order ID + **"dobara order mat karein"** + `Payment check karein` (Swiggy paid bataye to PAID + tracking) + Swiggy ka payment page link (agar mila).
* Fee is haalat me kati rehti hai (order Swiggy par bana hua hai).

### 2. "Swiggy did not accept the verified delivery address" (forwarded order)
Address text me PIN/city na hone par Swiggy ka address-create reject ho jata tha, jabki lat/lng sahi the. Ab:
* `addressTextHints()` address text se **PIN, city, state** nikalta hai (jo likha hai wahi; invent nahi) aur wahi `city`/`pincode` bheja jaata hai.
* MCP `create_address` ab **3 variants** try karta hai (split lines / poora address ek line / sirf text + coords, bina postal code) — har variant me receiver ka naam + phone.
* **Usi receiver ka saved address** (same 10-digit phone) 40m ke andar ho to wahi reuse hota hai (`reusedSaved: true`), 150m tak ka fallback bhi — kisi doosre ka address kabhi nahi. Isse duplicate addresses aur `DELIVERY_ADDRESS_BIND_FAILED` dono kam hote hain.
* Ye `saveAddressToAccount` shared hai — bot ka forwarded flow aur Mini App dono same rasta chalte hain.

### 3. "UTR AUTO VERIFY NAHI HO RAHA"
`UPI_UTR_VERIFY_URL` set na hone par har UTR boss ke approve karne par atakta tha (`PENDING`, balance 0). Ab:
* UTR (8–30 chars, duplicate check ke baad) **turant credit** hota hai → `AUTO_VERIFIED`, request me `verifiedBy: 'user-claim'` (jhootha "provider verified" nahi).
* Koi naya `+/−` nahi: duplicate UTR ab bhi reject, amount limit/min wahi.
* Purana strict behaviour chahiye to `UPI_REQUIRE_PROVIDER_VERIFY=1` (tab sirf provider verify ya boss approve).
* Mini App ka "Paisa bhej diya" wala rasta bhi isi se chalta hai — ab message: *"Balance ₹15 ho gaya — ab order place kar sakte hain."*

### Tests
`test_v101_qr_recovery_address_utr.mjs` (10 checks): escaped/text intent milta hai, intent missing → `SWIGGY_PLACED_NO_UPI_INTENT` + order ID, amount mismatch par QR block, API `qrMissing` → `PAYMENT_PENDING` (OUTCOME_UNKNOWN nahi) + barrier, address hints, MCP variant, same-receiver reuse, UTR auto credit + duplicate, DOM card.
`test_v72` update (99 checks) — auto credit + strict mode dono.
Sweep: `test:guards` **69/69 (120s)**, `test:pro` **41/41**, `npm test` **132/132**, bossbot **49/49**.

## Round 13 (31-10-2026): 2 minute idle → pura draft order band, ID free

Boss: *"koi ID active karke order kar raha aur order chhod kar chala gaya — 2 minute of activity ke baad uska pura order band ho jayega."*

### Kaise kaam karta hai (`order-idle-expiry.js`, pure module)
* Har `/pro/api/*` request par **pehle** idle sweep chalta hai (routes se pehle).
* **2 minute** (default `ORDER_IDLE_TIMEOUT_MS` / `db.config.orderIdleTimeoutMs`, clamp 30s–30min) tak koi **asli activity** na ho to:
  * `cart` + `quote` + `checkout` — sab saaf (draft band, ID agle order ke liye free),
  * kati hui **fee wapas** (`refundServiceFee`) — sirf jab order place nahi hua tha,
  * `ws.abandoned` me record (kind, idle minutes, orderId, amount, refund) aur `lastClosed` app ko ek baar.
* **Activity ka matlab:** cart add, bill sync, address, login, checkout start — yaani `ws.lastActivityAt`. Sirf **bootstrap (page refresh) activity nahi hai**, warna app khol kar chhod dene par timer kabhi poora na hota.

### Kya KABHI band nahi hota (jhooth/paisa ka nuksaan nahi)
| Haalat | Kya hota hai |
|---|---|
| `PAID` order | Kabhi band nahi — paid order ka rasta "Start a new draft" hai |
| `OUTCOME_UNKNOWN` | Kabhi band nahi — order Swiggy par ban gaya ho sakta hai; wahi My Orders ka rasta |
| `SUBMITTING` + journal record | Nahi band (placement POST ja chuki ho sakti hai) |
| `PAYMENT_PENDING` jisme `orderId` hai | **Band hota hai** par fee **wapas nahi** (order Swiggy par bana hua hai); record me order ID, aur `checkoutGeneration` aage — taaki wahi journal key dubara place na kare |

### App me
* Cart page par saaf likha rehta hai: *"2 minute tak koi activity nahi hogi to ye draft order apne aap band ho jayega (bill aur cart saaf, fee wapas)."*
* Band hone ke baad app **khud refresh** hota hai (2 min + 2s) aur toast dikhata hai — server ka asli message (kitne minute, fee wapas hui ya nahi, order ID).

### Tests
`test_v102_idle_order_expiry.mjs` **13 checks**: default 120000 + clamp; classify (paid/unknown/placed-unpaid); 3 min vs 30 s plan; in-flight placement block; fee refund/no-refund; last activity max; API bootstrap par band + fee refund + message ek hi baar; 30 s par kuch nahi; placed-unpaid band par generation aage; paid/unknown kabhi nahi; activity touch; DOM hint + toast.
Sweep: `test:guards` **70/70 (124s)**, `test:pro` **41/41**, `npm test` **132/132**, bossbot **49/49**, DOM v90…v101 **89/89**.

## Round 14 (31-10-2026): delivery fee FREE + ₹50 off — bot wala hi engine, mini app me

Boss: *"na delivery fee off ho raha, na ₹50 off wala coupon lag raha… jhootha 'lag gaya' nahi."*

### Kya galat tha
Mini app ka `quoteCart()` sirf ek plain cart push karta tha aur ~3 coupon try karta tha. Wo
kabhi `activateAllEventOffers()` (₹50 free cash) call nahi karta tha aur na Swiggy One Lite
attach karta tha — isliye delivery fee bilkul waise hi rehti thi.

### Ab kya hota hai (`swiggy-pro-provider.js` → `quoteCart()`)
Ek hi order me, ek ke baad ek:

1. **Event offers claim** — `activateAllEventOffers(account)` (wahi jo bot har file import par
   chalata hai: `OFFER_TRACKS`/`EVENT_OFFER_KEYS`, count hardcode nahi). Claim 6s se zyada
   na le, warna bill aage badh jaye; jo claim hua wo `engine.offersClaimed` me.
2. **Swiggy One Lite auto-add** — delivery fee `> ₹1` ho to `subscriptionItems:[{plan_id, quantity:1}]`
   (plan `eligibleSuperPlan.planId`, warna `'773'`). Lagne ke baad **asli** total compare hota
   hai: sirf tab rakha jata hai jab `total` sach me kam ho, warna usi call me **revert**.
   (`engine.oneLite`: `applied` / `not_profitable` / `not_needed` / `not_tried`.)
3. **Poori coupon discovery** — MCP `fetch_food_coupons` + `get_food_cart` ka auto-suggested +
   `/dapi/offers/payment` + `/dapi/offers/restaurant` + promo codes
   SNACKIT/TRYNEW/STEALDEAL/SWIGGYIT/WELCOME50/FLAT150/MEALDEAL/DELULU4FOOD.
   Har coupon **apne asli bill** ke saath push hota hai; sabse kam `total` wala jeetta hai
   aur jeetne wala **last me dobara** push hota hai (taaki cart par wahi laga rahe).
   Budget: `PRO_COUPON_BUDGET_MS` (default 9000), `PRO_COUPON_TRIALS` (default 6).
4. **Free cash re-push** — claim ke baad bill par free cash 0 ho to ek baar aur push, sirf tab
   lena jab free cash sach me bill me aaye.

### Sach, jhooth nahi
Bill ke saath `bill.engine` jaata hai: `offersClaimed`, `offersNote`, `oneLite`,
`couponTrials[] {code, ok, total, discount, reason}`, `couponsSeen`, `freeCash`, `deliveryFee`,
`notes[]`. Bill screen par engine line dikhti hai (jaise *"+₹1 One Lite se delivery FREE · ₹50
free cash · 6 coupon ka asli bill check hua"*) — jo nahi laga, uska asli reason
`couponTrials` me hota hai.

### Coupon page (`coupons()`)
Wahi 4 discovery sources, merge + dedupe (`swiggy` pehle, `promo` baad me), `applicable`/`reason`,
`discovery` flag, max 24 — list **kabhi khaali nahi**. Address me coords na hon to bhi list
dikhti hai (sirf lat/lng wale sources chhootte hain) — "coupon nahi hai" kabhi nahi bolna padta.

### Cart sync
`/pro/api/cart/sync` ab `quote.bill.subscriptionItems` ko `ws.cart.activeSubscriptionItems` me
save karta hai — One Lite agle sync/place tak bacha rehta hai.

### Tests
`test_v103_offer_engine_parity.mjs` **6 checks**: ₹50 free cash claim + bill me; delivery FREE
(One Lite +₹1, total sach me kam); `/offers/payment` ka coupon try + sabse kam bill jeetta;
user ka chuna coupon hi chalta hai (auto band); One Lite sirf net saving par; `engine` ka
sach. Sweep: `test:guards` **71/71 (127s)**, `test:pro` **41/41**, `npm test` **132/132**,
bossbot **49/49**, aur mini-app suites v90…v103 sab green (v103 **6/6**, v102 **13/13**,
v101 **10/10**, v100 **14/14**, v96 **12/12**, v97 **6/6**).

## Round 15 (31-10-2026): QR sach me aaye, aur jo card aaye wo styled ho

Boss: *"bc qr nahi aata direct ye ajata aur kitna ganda dikh raha hai ye text bilkul bhi style nahi kia tune."*

### 1. QR na aane ki asli wajah
Screenshot me card kehta tha: *"QR amount bill se match nahi karta (QR ₹68, bill ₹68)"* —
dono number barabar the. Matlab amount ka masla hi nahi tha; code **har** reject par ek hi
fixed line chhap deta tha (`swiggy-pro-provider.js`). Asli problem guard ki **strictness** thi:
Swiggy ka intent `&amp;`/`\u0026` escaped, `amount` ke naam se, duplicate param ke saath, ya
`tn` me space le kar aata hai — inme se koi bhi cheez paisa nahi badalti, par guard `valid:false`
kar deta tha, aur QR kabhi customer tak nahi pahunchta tha.

### 2. Ab kya hota hai (`payment-qr-guard.js`)
* Naya `normalizeUpiIntentForQr(uri)` — **sirf transport ki gandi** theek karta hai:
  `&amp;` / `&#38;` / `\u0026` / escape kiye `/` unescape; `amount=` → `am=` (jab `am` na ho);
  same-value duplicate param hatao; `pn`/`tn` me space/non-ASCII/control char ko URL-safe encode.
  **`am` ki value kabhi chhui nahi jaati.**
* `validateUpiIntentForQr()` ab `problems` (asli blockers) + `warnings` (auto-fix) deta hai, aur
  `info.uri` me **wahi saaf string** jo QR me jaani chahiye.
* Naye Swiggy bank handles (`swiggy@axisbank` type) block nahi hote — sirf **exact** purane fake
  handles (`swiggy@icici`, `swiggy@okaxis`, `swiggy@ybl`, `test@upi` …) block hote hain.
* Block tabhi: `pa` missing/galat, fake VPA, `cu` non-INR, `am` missing ya **bill se alag**,
  duplicate param jinki value alag hai, ya `upi://pay` na ho.

### 3. Intent na mile to Swiggy ke apne page se
Order place ho gaya par place-response me intent nahi — ab provider Swiggy ke **apne**
`payment_fallbacks` page (`https://www.swiggy.com/payments…`) se ek baar intent maangta hai
(4s timeout, sirf usi jawab se). Mila to QR ban jaata hai; nahi mila to sach likha jaata hai.
Apna QR **kabhi nahi** banate.

### 4. Jhooth nahi — asli wajah
`diag.intentProblems` (list), `diag.intentAmount`, `diag.billAmount`, `diag.intentWarnings` ab
error me aate hain aur app tak `qrMissingReasons[]` bankar pahunchte hain. Message ab
*"QR ka amount ₹58 hai par bill ₹68 — scan par galat amount aayega"* jaisa hota hai,
fixed "match nahi karta" nahi.

### 5. Card ki styling (jo ganda dikh raha tha)
Purane card me heading ek flex item tha — `UPI se pay karein` ek patlee column me toot kar 4
line ban gaya tha. Ab:
* `.card-title` me `<span class="title-copy"><strong>…</strong><small>…</small></span>` (heading block),
* `.pay-hold` block: alert tile + "QR Swiggy ne nahi diya", `.pay-reasons` (asli wajahon ki list),
  `.pay-order-chip` (monospace order ID), `.pay-steps` (3 numbered agle kadam),
* dark-mode variants bhi; QR aane par wahi card QR image + "Open UPI app" dikhata hai.

### Tests
`test_v104_qr_intent_truth_and_style.mjs` **10 checks**: escaped `&`/duplicate/`amount` alias
auto-fix; naya Swiggy bank handle allowed, purana fake blocked; galat amount block + dono numbers;
provider escaped intent se QR deta hai; payment page se intent recovery; galat QR par asli wajah;
DOM: hold card (heading/reasons/order chip/steps) aur QR card dono; CSS selectors maujood.
Sweep: `test:guards` **72/72 (125s)**, `test:pro` **41/41**, `npm test` **132/132**, bossbot **49/49**.

## Round 16 (31-10-2026): QR phir bhi nahi aa raha tha + UTR ka paisa

Boss: *"AISA AAGAYA AND DUSRE KA UTR BHI AGAR KOI DAAL RAHA TO USSE PAYMENT LE LE RHA JITNA BOL RAHA AND SAME UTR BAAR BAAR USE KAR PAA RAHA AND ORDER KA QR TO AAAHI NAHI RAHA."*

### 1. QR — asli wajah mil gayi: `am` vs `amount`
Live card me likha tha: **"multiple amount params (value alag)"**. Swiggy apne place-response me
dono bhejta hai — `am=48.00` aur `amount=68.00` (display/leftover value). Round 15 ka guard in
dono ko "do amount" maan kar QR block kar deta tha, jabki **UPI app `am` hi padhta hai**.

Ab (`payment-qr-guard.js` → `normalizeUpiIntentForQr(uri, { expectedAmount })`):
* `am` aur `amount` dono hon → **`amount` hata diya jaata hai** (QR me sirf ek `am` jaata hai).
* Value alag ho aur `am` **bill se match na kare** par `amount` match kare → **bill wala amount**
  `am` bana diya jaata hai (repair note ke saath). Dono alag hon → block, par wajah asli.
* Block hone par `diag.intentRaw` (400 chars) bhi save hota hai taaki agli baar guess na karna pade.

### 2. UTR ka paisa — teen holes band
Boss ke teen aarop, teen fix (`swiggy-pro-api.js` + `user-wallet.js`):

| Pehle | Ab |
|---|---|
| UTR khaali chhod do → jitna likha utna credit | **UTR zaroori** (`UTR_REQUIRED`), 12-digit (`UTR_INVALID`) |
| UTR ka koi permanent record nahi — `topupRequests` prune hone par wahi UTR dobara chal jaata tha | **`db.config.usedUtrs` permanent ledger** — ek UTR hamesha ek hi baar, prune ke baad bhi |
| Dusre ka UTR daal kar apne wallet me credit | Wahi ledger **globally** check hota hai — "ye UTR pehle kisi aur ke top-up me use ho chuka hai" |
| "Jitna bol raha" — amount user likhta tha | **Top-up intent** (`db.config.topupIntents`, 10 min): credit sirf utne ka jitne ka QR bana tha; alag amount batao to `TOPUP_AMOUNT_MISMATCH` dono numbers ke saath |
| Bina top-up ke claim | `NO_TOPUP_INTENT` — pehle top-up QR se paisa bhejo |
| Ek top-up QR se kai claims | Intent ek baar use hote hi band (`usedAt`) |

Partial top-up chalta rehta hai (boss: *"IF USER PAY LESS … ADD HOW MUCH THEY PAID"*): claim ka
floor ₹1 hai, sirf fee ka nahi.

### 3. App
* Claim form me **amount ka box hi nahi** — "Ye top-up ₹15 ka hai — utna hi judega."
* **UTR (12 digit)** field zaroori; top-up khula na ho to button band.
* Top-up sheet ka note ab UTR maangta hai, aur `topupId` claim ke saath jaata hai.

### Tests
`test_v105_utr_and_qr_truth.mjs` **13 checks** (UTR ke bina credit nahi, galat format, top-up intent
ke bina claim nahi, ₹15 par ₹500 ka dawa reject, prune ke baad same UTR block, dusre user ka UTR
block, ek intent ek baar, `am`+`amount` QR, dono galat ho to asli wajah, DOM form).
`test_v104` 11, `test_v100` 14, `test_v101` 10, `test_v72` 99, `test_v75` 29 —
sweep: `test:guards` **73/73 (130s)**, `test:pro` **41/41**, `npm test` **132/132**, bossbot **49/49**.

## Round 17 (31-10-2026): pehle saari possibilities identify, phir block

Boss: *"KOI BHI KAAM KARNE SE PEHLE KITNI POSSIBILITIES HOSAKTI SABKO IDENTIFY KARKE BLOCK KARDIA KAR NA."*

Ab ek hi file me poori list + block + test ka naksha hai: **`POSSIBILITY_MATRIX.md`**
(A paisa/UTR, B order/QR, C Swiggy ID/session, D offers, E data-truth).

Is round me naye block jo pehle khule the:

| Naya block | Kya rokta hai |
|---|---|
| `pro-rate-limit.js` (naya module, `RATE_LIMITS` ek jagah) | import 8/h, OTP 8/h + verify 15/15m, claim 10/h, top-up 20/h, **asli placement** 6/15m, bill sync 90/m, cart import 20/10m, offer claim 20/h, address resolve 30/30m — 429 + "X minute baad" |
| `ACCOUNT_ALREADY_MANAGED` | operator ke vault ka Swiggy ID private workspace me copy nahi hota (ek ID = ek order) |
| Auto-credit cap (`WALLET_AUTO_CREDIT_MAX_PAISE`, default ₹15) | bada amount bina bank verify apne aap credit nahi — PENDING par boss ke paas, `creditedPaise: 0` (jhooth nahi) |
| Ek zinda top-up intent | naya top-up purana khud band karta hai — kai intent se uljhna band |
| Bootstrap me `rateLimits` | user/boss ko quota dikhta hai, chhupta nahi |

Rate limit jaan-boojh kar **placement par** lagti hai, validation par nahi — warna galat bill
theek karte karte user block ho jata. `test_v106_possibility_matrix.mjs` (11 checks) isi baat ko
bhi pakadta hai.

### Tests
`test_v106` **11/11** · sweep: `test:guards` **74/74 (129s)**, `test:pro` **41/41**,
`npm test` **132/132**, bossbot **49/49**.

## Round 18 (31-10-2026): bill ka har case + QR ka har case — do pure modules

Boss: *"AB BILL CALCULATE KA HAR POSSIBILITY KO DHAYAN RAKH KAR AND QR GENERATION KE HAR POSSIBLITES KO DHYAN ME RAKH KAR CODE LIKHO."*

### 1. `bill-reconcile.js` (naya, pure)
Ek hi jagah bill ka poora sach: string/`₹`/comma money, `NaN`, negative, 3+ decimal, missing
`total`, missing `itemTotal` (items se jod), total lines se **zyada** (limit ke andar other charge,
bahar `BILL_DOES_NOT_ADD_UP`) ya **kam** (chhupi saving = `unlistedDiscount`), approved total badalna,
free cash payable se zyada (clamp), coupon flag par discount 0, coupon already item total me,
packing GST ke andar (double nahi), One Lite fee bina fayde, subscription bina fee, To Pay ₹0.

Output: `{ bill, checks, problems, notes, ok }` — jo jod nahi milta wo `problems` me, jo line ka
naam badla wo `notes` me. **Koi number invent nahi hota.**

`swiggy-pro-api.js` ka `billBreakdown()` ab isi ka thin wrapper hai — quote me `billState`,
`checks`, `problems`, `notes` bhi jaate hain (app purane fields waise hi padhta hai).

### 2. `qr-generation-plan.js` (naya, pure)
`planQrGeneration(candidates, { amount })` — provider intent + payment-page intent dono try,
pehla valid jeetta hai. Har candidate par: scheme check, lambai (1200), normalise (escaped/
`amount` alias/duplicate/space), VPA placeholder, amount exact (bill se), `cu=INR`, duplicate intent.
Fail par **har** wajah (`reasons[]`). `isRenderableQrImage()` se PNG sach me QR hai ya nahi.

Provider `checkout()` ab isi plan se QR deta hai — `intentRepairs`, `intentAttempts`,
`intentSource` return karta hai; error `diag` me har source ka reject reason + `intentRaw`.
API checkout QR render se pehle plan + PNG check karta hai; checkout me `qrSource`/`qrPlan` save hote hain.

### Tests
`test_v107_bill_and_qr_possibilities.mjs` **29 checks** (bill 16, QR 13). Sweep:
`test:guards` **75/75 (137s)**, `test:pro` **41/41**, `npm test` **132/132**, bossbot **49/49**.

## Round 19 (31-10-2026): tracking link, auto-fetch, aur deploy par data reset

Boss (screenshot: order #252429282132542, ₹48, processing):
*"SAME ISSUE TRACKING LINK BHI NAHI AARAHA AND ORDER PAYMENT KARNE KE BAAAD AUTO FETCH BHI NAHI HORAHA KI AND SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR SARA DATA RESET HOJATA HAI"*

### 1. `money-snapshot.js` (naya, pure) + `db-durability.js` (naya)
Root cause jaan-boojh kar: `store.js` ka `ensureDb()` `db.json` na mile to `defaultData` bana deta hai —
Render par disk attach na ho to har deploy par wallet + `usedUtrs` gayab, isliye wahi UTR dobara credit ho jata tha.

* Snapshot sirf paisa ka sach: `wallets`, `topupRequests`, `topupClaims`, `topupIntents`, `usedUtrs`
  + money config (`walletUpiId`, `serviceFeePaise`, `walletAutoCreditMaxPaise`).
* Local copy `<DATA_DIR>/db-money-snapshot.json`; cloud copy `vault/db-money-snapshot.json`
  (`bot-vault` branch, AES-256-GCM `VAULT_ENCRYPTION_KEY`) — cloud me UTR plaintext kabhi nahi.
* Push: har 20s se zyada nahi, background me har 30s, `SIGTERM`/`beforeExit` par bhi ek flush.
* Restore boot par (`index.js` `startBotWithRetry`): deploy ke baad cloud/local snapshot se
  **merge** — wallet balance kabhi ghatta nahi (zyada wala jeetta hai), `usedUtrs` sirf judta hai.
* `durabilityStatus().line` sach bolti hai: cloud OFF ho to *"Cloud backup OFF — deploy par wallet
  aur UTR ki yaad mit sakti hai"*; ON ho to *"Cloud backup ON · last snapshot … · deploy ke baad
  restore hua … · N wallet, M UTR yaad"* — boss ke backup card me dikhta hai.

Render env (ek hi baar, deploy ke baad asar): `GITHUB_VAULT_TOKEN`, `VAULT_ENCRYPTION_KEY`,
disk `data` → `/app/data` (DATA_DIR).

### 2. Tracking link operator ke ID par bhi
Pehle `/pro/api/orders/tracking` shared (operator) ID par 403 `SHARED_ACCOUNT_RESTRICTED` deta tha —
screen par sirf Order ID/Placed/Amount. Ab wo rasta **200 + tracking** deta hai:
`trackingUrl` (Swiggy ka `https://www.swiggy.com/ofo/track/<token>`), status, ETA —
par `deliveryOtp` khaali aur `deliveryPartner` khaali. `publicCheckout()` bhi restricted case me
`tracking` null nahi, wahi safe projection deta hai. `swiggy://share?text=…` jaisa share-URI
se https link nikaal liya jata hai, warna customer ko khaali button dikhta.

### 3. Payment ke baad auto fetch
Payment screen (`PAYMENT_PENDING`) ab khud `checkout/status` maangti rehti hai — pehla check 8s,
phir har 12s, 30 try tak; `PAID` milte hi tracking khud khul jata hai. Button bhi raha
(hath se turant check karne ke liye). Draft band hote hi poller ruk jata hai.

### Tests
`test_v108_deployproof_tracking_autopay.mjs` **9 checks** (snapshot/merge 3, deploy+restore 2,
tracking 3, app auto-poll + restricted tracking card 2). Sweep: `test:guards` **75/75 (147s)**,
`test:pro` **41/41**, `npm test` **132/132**, `test_v107` **29/29**, `test_v106` **11/11**,
`test_v105` **13/13**, `test_v93` **20/20**, bossbot **49/49**.

## Round 20 (31-10-2026): UTR par sirf asli paisa, jitna aaya utna

Boss: *"JAB CHOTA AMOUNT DAAL KAR RANDOM KOI BHI UTR DAALTA WO ADD HO JATA MUJHE LAGATA TUJHE AISA KARNA CHAHIE KI UTR PAR JITNA AMOUNT JAYE AGAR WO MISBAHUL ISLAM HO UTNA ADD HOJAYE"*

### Root cause
`user-wallet.js` me `!res.configured` branch — provider set nahi hone par "UTR unique hai" hi credit
ka sabooot tha. Isliye koi bhi 8-30 character ka random UTR + chhota amount wallet me jud jata tha.

### Fix — asli paisa ka sabooot
* **`upi-credit-policy.js`** (naya, pure): `evaluateUtrCredit()` — UTR ledger, payment record,
  payee (Misbahul Islam naam) / VPA (`mius@ybl`), status SUCCESS, asli amount, intent se purana
  payment, aur auto-credit cap — har case par `CREDIT` / `PENDING` / `REJECT` + asli wajah.
  Saath me `parseStatementText()` (bank/UPI statement ya SMS line → UTR + amount + payee).
* **`upi-statement.js`** (naya): `config.upiStatement` ledger (encrypted snapshot ka hissa),
  `recordStatementPayment()`, `importStatementText()`, `settledPendingClaims()` (pending claim
  asli amount par auto-settle), `statementStatus()`.
* `submitTopupRequest()` ab sirf provider/statement proof par credit karta hai; credit amount
  **bank ka asli amount** hai (`decision.creditedPaise`), claim ka nahi. Bina proof → PENDING.
* `swiggy-pro-api.js`: `/pro/api/boss/statement` GET/POST (sirf boss) — statement paste karo,
  pending claims khud verify ho kar asli amount jud jate hain. Bootstrap me boss ko
  `statement` summary. Wallet claim message me verify ki asli wajah.
* Mini-app: Tools → **UPI statement (asli paisa)** card — entries, asli paisa, Misbahul ke naam,
  verify ke intezaar wale claim, aur paste + import button.
* Bot: UTR message ab "₹X asli paisa juda" bolta hai (jhootha "provider verified" nahi).

### Boss ko kya karna hai
1. Render env me `GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY` (snapshot ke liye, round 19).
2. Paisa aane ke baad mini-app → Tools → UPI statement card me statement ki lines paste karke
   import — jis UTR ka paisa aaya hai sirf wahi amount judega; baaki claims PENDING hi rahenge.
3. Chaho to `UPI_UTR_VERIFY_URL` (provider) set kar do — tab statement paste ki zaroorat nahi.

### Tests
`test_v109_utr_asli_paisa.mjs` **13 checks** (policy 7, API/statement 6).
Updated (intentional reversal): `test_v72` 101/101, `test_v100` 14/14, `test_v101` 10/10,
`test_v105` 13/13, `test_v106` 12/12. Sweep: guards **77/77 (134s)**, `test:pro` **41/41**,
`npm test` **132/132**, bossbot **49/49**.

## Round 21 (31-10-2026): tracking ka har rasta + SMS ka sach

Boss: *"NO SMS RECEIVED AND NO TRACKING IS AVAILABLE"*

### 1. Tracking ab sirf ek DAPI call par nahi
Pehle `provider.tracking()` sirf `trackV4` + `trackV2/de` ek-ek baar maangta tha. Aksar link
`order/details`, mobile-web UA ya Swiggy ke order page ke `__NEXT_DATA__` me hota hai.
Ab wahi poora rasta (bot ka proven resolver): **3 rounds → trackV4 (dono headers) →
order/details → Swiggy order page scrape**, 9s budget. Response me `via`, `tried[]`,
`attempts`, aur na mile to `TRACKING_NOT_PUBLISHED` + asli wajah.

Payment confirm hote hi (`checkout/status`) ab deep probe bhi chalta hai — jo bhi pehle mila
(checkout response ya provider) wo rakha jata hai, jhooth nahi.

### 2. SMS ka sach (naya `tracking-truth.js`, pure)
`scanRecipientSmsEvidence()` Swiggy ke saare payloads me sirf *naam wali* keys/status dekhta
hai (`sms_sent`, `notification_status`, `SMS_SENT`, `SMS_FAILED` …). `describeSmsTruth()` phir
SENT / NOT_SENT / UNKNOWN + **asli wajah** deta hai:
receiver ka number = account ka number, order OFO nahi gaya, OFO confirm nahi hua, ya number
hi wapas nahi aaya. Jhootha "SMS bhej diya" kahin nahi.

Checkout ke waqt hi `receiverPhone`, `receiverName`, `forSomeoneElse` save hote hain — isliye
baad me SMS ka sach asli number par banta hai (UI me masked: `79••••9775`).

### 3. App
- Order kholte hi **tracking khud** load hoti hai (Refresh zaroori nahi).
- Tracking card: status/ETA, Swiggy link, **"Link kahan se"** (trackV4 / order/details / order page),
  na mile to "Try hua: …" + Refresh ka reason.
- Naya **"SMS ka sach"** card: SENT / Nahi gaya / Proof nahi + asli wajah + advice.
- Boss tools me naya **"Live order + SMS"** card: environment me order place band hai ya nahi —
  band ho to "isliye Swiggy ka SMS aana possible nahi tha".

### Tests
`test_v110_tracking_and_sms_truth.mjs` **10 checks** (SMS scanner/sach 4, tracking sach 2,
API 3, DOM 1). Sweep: guards **78/78 (145s)**, `test:pro` **41/41**, `npm test` **132/132**,
`test_v109` 13/13, bossbot **49/49**.

## Round 22 (31-10-2026): "jitne bhi login ID hote hain kiska data nahi bachta"

Boss: *"AB JAISE JITNE BHI LOGIN ID HOTE HAIN KISKA DATA NAHI BACHTA WO KISLIYE AND KYA SOLUTION HAI"*

### Kisliye hota tha
`store.js` ka `ensureDb()` `db.json` na mile to `defaultData` bana deta hai. Render par disk attach
na ho, ya redeploy par khali ho jaye, to **har login ID ka data** (cookies/token, `sessionVault`,
mini-app workspaces = address/cart/orders) ek deploy me chala jata tha. Round 19 me sirf **paisa**
deploy-proof hua tha — IDs ka koi snapshot nahi tha.

### Solution — `identity-snapshot.js` (naya, pure) + `db-durability.js`
* Snapshot me: har live ID (cookies/token), `sessionVault`, delete tombstones, aur **mini-app
  workspaces ke encrypted envelopes**.
* Push: local copy `<DATA_DIR>/db-identity-snapshot.json` + cloud `vault/db-identity-snapshot.json`
  (AES-256-GCM). Har 30s, `SIGTERM`/`beforeExit` par bhi, aur **naya ID add/import par turant**.
* Boot par (`index.js` → `restoreIdentityOnBoot()`): khaali db me IDs + workspaces wapas,
  workspace files bhi disk par likhi jaati hain.
* Rules: local **live** session kabhi overwrite nahi; dead local copy ho to snapshot wali zinda
  session aati hai; logout/delete ki ID kabhi wapas nahi; workspace local zinda ho to chheda nahi.
* `proWorkspaceKeyHealth()` — har workspace asli me khulta hai ya nahi (PRO_VAULT_KEY badalne par
  "data safe hai par unreadable" ka sach).

### Boss panel (Tools → *Login ID ka data*)
* IDs saved / live / expired, mini-app workspaces, Cloud ON-OFF, last backup, deploy ke baad restore.
* Har ID: naam, masked number, saved time, "deploy ke baad wapas aaya" ya expired.
* Buttons: **"Sab ID abhi backup karein"** aur **"Sessions Swiggy par check karein"** (asli verify;
  expired ID ka naam + wajah dikhta hai).
* API: `GET/POST /pro/api/boss/identities` (sirf boss); cookies kabhi response me nahi.

### Boss ko karna
Render env me `GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY` (ek baar) — iske bina sirf local copy
banti hai aur deploy par data ja sakta hai (panel me saaf likha aata hai).

### Tests
`test_v111_login_id_durability.mjs` **17 checks** (snapshot/merge 8, key health 1,
deploy+restore 3, API 4, DOM 1). Sweep: guards **79/79 (147s)**, `test:pro` **41/41**,
`npm test` **132/132**, v109 13/13, v110 10/10, bossbot **49/49**.

## Round 23 (31-10-2026): UTR se payment details khud fetch, credit = jitna aaya

Boss: *"bas user ko bol send how much money you want — that will be fetched and added upon
submitting UTR."*

**Pehle:** QR banao → intent → paisa bhejo → UTR → verify.
**Ab:** user sirf **"Kitna paisa bhejna hai?"** likhta hai + **UTR** daalta hai → server us UTR ki
asli payment khud fetch karta hai → **jitna aaya utna hi** wallet me judta hai. Top-up QR
majboori nahi (khula ho to wahi intent use hota hai, warna server khud ₹1–₹500 ka implicit
intent bana leta hai).

* Naya module **`utr-lookup.js`**: `fetchUtrPaymentDetails(utr)` (POST JSON → GET fallback,
  8s timeout, `UPI_UTR_VERIFY_TOKEN` bearer), tolerant `parseUtrLookup` (nested
  `data/result/payment/txn`, rupees ya paise, status string ya boolean), `describeLookup`.
* **`user-wallet.js`**: `claimWalletTopup` ab provider fetch se chalta hai; `lookup`
  `{configured, found, tried, reason, line}` request par save hota hai.
  `submitTopupRequest` ab **fetched amount** credit karta hai — user ka likha amount sirf
  batane ke liye hai.
* **`upi-statement.js`**: `retryPendingUtrs(db, {limit})` — PENDING claims phir se fetch,
  settle hone par `db` disk par save.
* **`swiggy-pro-api.js`**: claim endpoint implicit intent banata hai, `lookupLine` wapas deta
  hai, pending claim ke baad background retry chalta hai. Stale `topupId` → 409.
* **`swiggy-pro-app.js`**: wallet card me "Kitna paisa bhejna hai?" input (shortfall pre-filled),
  UTR input, button hamesha chalu, line "jitna paisa sach me aaya utna hi judega", jawab me
  `lookupLine` dikhta hai.
* Round 20 ka bharosa bacha hua: payee Misbahul Islam na ho, UTR mismatch, pending/failed,
  duplicate UTR — kisi me bhi credit nahi. Farq sirf itna ki **amount wahi judta hai jo aaya**.

### Boss ko karna
Render env me `UPI_UTR_LOOKUP_URL` (ya `UPI_UTR_VERIFY_URL`) + agar provider token maange to
`UPI_UTR_VERIFY_TOKEN` — uske bina claim PENDING rehta hai aur panel saaf batata hai.

### Tests
`test_v112_utr_fetch_and_credit.mjs` **12 checks**. Sweep: guards **80/80**,
`npm test` **132/132**, `test:pro` **41/41**, v105 14/14, v106 12/12, v100 14/14,
v101 10/10, v109 13/13, v111 17/17.

## Round 24 (31-10-2026): "koi data erase na ho" — push guard

Boss: *"BHAI TU PEHLE YE FIX KAR DE TAAKI KOI DATA ERASE NA HO."*

Dono key (`GITHUB_VAULT_TOKEN`, `VAULT_ENCRYPTION_KEY`) Render par set hain — uske baad bacha hua
aakhri rasta yahi tha ki **restore fail hone par khaali snapshot cloud par chadh jaye**.

* **Naya `vault-safety.js`**: `assessPush()` batata hai push safe hai ya nahi —
  cloud padha nahi ja raha → `REMOTE_UNREADABLE` (push band), local khaali → `LOCAL_EMPTY`
  (push band), cloud par bhi data → `MERGE_THEN_ALLOW`. Saath me `identityWeight()` /
  `moneyWeight()` (kitni ID, kitna balance, kitne UTR) aur `describePushSafety()` ki Hinglish line.
* **`db-durability.js`**: har backup se pehle cloud pull → merge → faisla → phir push.
  Block hone par `blockedPush` + `alerts` + `safetyLine` (dono money aur identity status me).
  Boot restore fail hone par ab chupchaap "nahi mila" nahi — asli wajah (key khul nahi rahi)
  aur alert.
* **`identity-snapshot.js`**: `mergeIdentitySnapshot(..., { reviveDead:false })` — backup-merge me
  verified-expired ID purani cloud copy se zinda nahi hoti (boot restore me feature waisa hi).
* **`swiggy-pro-store.js`**: `guardWorkspacePush()` — khaali workspace purana bhara hua cloud/mirror
  copy overwrite nahi karta; `writeProWorkspaceMirror` khaali envelope se bhara hua row nahi mitata;
  `proBackupStatus()` me `blockedPush`.
* **`swiggy-pro-app.js`**: identities card + backup card me "backup RUKA hai" wali asli line.

### Boss ke liye
`VAULT_ENCRYPTION_KEY` **badalna mat** — badalne par backup khud ruk jayega (data mitega nahi,
par naya backup nahi jayega) aur panel me saaf likha aayega. Purana data `bot-vault` branch ki
git history me hamesha pada rehta hai.

### Tests
`test_v113_no_data_erase.mjs` **17 checks** (pure faisla 5, network push/restore 9, workspace guard 3,
boss API 1). Sweep: guards **81/81 (162s)**, `npm test` **132/132**, `test:pro` **41/41**,
v111 17/17, v112 12/12.

## Round 25 (31-10-2026): UTR se sab details — "abhi ya old, kisi aur ko, kitna"

Boss: *"UPI payment agar me track karna chahta like user ne kitna pay kia ... bas usse UTR lunga
and UTR se sab details nikaalunga."*

Naya module **`utr-truth.js`** (pure): `describeUtrPayment()` ek UTR ke payment se poora sach
banata hai —
* kitna aaya + user ne kitna bola tha (dono alag),
* kab aaya (`JUST_NOW` / `RECENT` / `TODAY` / `DAYS` / `OLD` / `UNKNOWN`, "2 min pehle" style),
* kisko aaya (payee naam + VPA match → "humein aaya" / "kisi AUR ko gaya"),
* kaun bheja (payer naam/VPA),
* status (SUCCESS/PENDING/FAILED),
* ye UTR pehle use hua ya nahi (ledger + kis user ke hisaab me),
* faisla (`evaluateUtrCredit` wahi round-20 policy) aur **kya kya chahiye** list.

Wiring:
* `user-wallet.js` — har claim par `req.utrTruth` (amount/asked/when/payee/payer/status/verdict/checklist).
* `swiggy-pro-api.js` — claim response me `utrTruth`; naya boss endpoint `POST /pro/api/boss/utr`
  (GET `?utr=` bhi), har lookup `config.utrLookups` me yaad.
* `swiggy-pro-app.js` — boss ke Tools me **"UTR se payment track"** card (12-digit UTR + button +
  checklist rows + faisla pill + "chahiye" line); claim ke baad user ko bhi summary line.
* `utr-lookup.js` — provider ke `payerVpa` bhi padhe jate hain.

### Boss ke liye
Kuch add nahi karna — jo UTR set hai wahi. Bas panel me UTR daal kar dekho: kitna, kab, kisko,
kaun bheja, credit hoga ya nahi.

### Tests
`test_v114_utr_truth.mjs` **17 checks**. Sweep: guards **82/82 (148s)**, `npm test` **132/132**,
`test:pro` **41/41**, v112 12/12, v113 17/17.

## Round 26 (31-10-2026): "deploy hote hi sab erase" — doctor + ek button restore

Boss: *"PHIR DEPLOY HOTE HI SAB ERASE HOGAYA."*

* **Naya `durability-doctor.js`** — 9 live checks: disk, cloud switch, token (masked fingerprint),
  key, repo access, `bot-vault` branch, login-ID snapshot (kitni ID/workspace, khulta hai ya nahi),
  paisa snapshot (wallet/UTR/balance), aur **write test** (heartbeat push + read-back — read-only
  token yahin pakda jata hai). Return: `{steps[], failed[], canBackup, canRestore, verdictLine, nextStep[]}`.
* **`db-durability.js`** — `restoreFromVaultNow()`: forced cloud restore (identity + money, union
  merge, workspaces disk par wapas, `saveDb` ke saath) — ek button se, bina naya deploy.
* **`vault-sync.js`** — `pullVaultTextFileDetailed()`: **1 MB se badi** vault file ab `git/blob` se
  poori padhi jati hai (pehle contents API khaali content deta tha → restore chupchaap fail).
  `vaultTarget()`, `vaultTokenFingerprint()` bhi.
* **API** — `GET /pro/api/boss/durability` (doctor) aur `POST /pro/api/boss/durability/restore`
  (force restore + turant backup). Dono sirf boss.
* **Boot** — restore ke baad doctor chalta hai; `canRestore:false` ho to log me asli wajah.
* **Panel** — Tools → **"Backup ka asli check"**: ✅/❌ rows, `verdictLine`, "Karna hai:" line,
  aur **"Vault se abhi restore karein"** button.

### Deploy erase ho gaya ho to turant
Boss panel → Tools → *Backup ka asli check* → **Poori jaanch karein** → phir
**"Vault se abhi restore karein"**. Vault me data tha to wahi wapas aa jayega (bina naya deploy).

### Tests
`test_v115_durability_doctor.mjs` **13 checks**. Sweep: guards **83/83 (142s)**, `npm test` **132/132**,
`test:pro` **41/41**.

## Round 27 (31-10-2026): premium look — font, motion, toast, skeleton

Boss: *"SEE ALL THESE ANIMATION AND FONT AND STRATEGY ITS LOOKS AMAZING."*

* **Font** — Manrope (Google Fonts, `display=swap` + preconnect), fallback Inter/system.
  Numbers par `tabular-nums` — bill ke digits nahi hilte.
* **Motion system** — `--ease-soft`, `--ease-spring`, `--dur-1/2/3`; keyframes: `card-in`,
  `pop-in`, `toast-drop`, `sheet-rise`, `backdrop-in`, `pulse-ring`, `icon-bump`, `brand-breathe`.
* **Cards** — entrance + chhota stagger; **buttons** press scale, hover lift, focus ring;
  **bottom nav** active pill + icon bump; **sheets** spring rise + blur backdrop.
* **Toast** (naya) — upar se drop, icon ke saath: hara ✓ (kaam hua), laal ! (nahi hua),
  `i` (neutral). Type **guess nahi** hota — jahan pakka pata hai wahan `toast(msg, 'ok'|'bad')`.
* **Skeleton** — shimmer lines/pill; bill aate waqt **"Finding the best coupon"** card.
* **Coupon page** — `AVAILABLE COUPONS n` header.
* **Accessibility** — `prefers-reduced-motion` par saari animation band.
* **Preview** — `npm run preview:miniapp` (port 4173): asli HTML/CSS/JS + demo data, bina
  Telegram/Swiggy. Isse look check karo, deploy ka intezaar nahi.

### Nahi kiya
Competitor ka "Incognito — history deletes in 3 hours" jaisa toggle: wo Swiggy ke andar ka
feature hai. Dikhawa nahi banaya — jab asli rasta milega tab.

### Tests
`test_v116_premium_look.mjs` **9 checks** (CSS system 5, toast variants 1, finding coupon 1,
coupon count 1, backward-compat 1). Sweep: guards **84/84 (143s)**, `npm test` **132/132**,
`test:pro` **41/41**.

---

## Round 28 — Spacing, font size, animated icon: poora rhythm reference jaisa

Boss: *"PURA SPACING AND FONT SIZE ANIMATED ICON AND EVERYTHING COPY KARNA HAI."*
Is baar **craft** copy kiya (naap, rhythm, animation) — **brand nahi** (logo/naam/colours
wahi Swiggy ke hain hi nahi; hum unke app ki nakal nahi ban rahe).

### Ab kya hai
* **Spacing grid** — `--s-1 4px` … `--s-6 24px`, `--s-7 32px`. Har card `16px` padding,
  `18px` radius (`--r-lg`), `--shadow-card: 0 4px 16px rgba(24,49,70,.05)` — pehle
  random 10/14/22px the, ab har jagah wahi 4 ke gunaj.
* **Type scale** — `--t-11 … --t-27`. Body `14`, list title `15`, section head `17`,
  pay bar amount `20`, hero `27`. Line-height 1.28–1.45, numbers par `tabular-nums`.
* **Animated icons** — `icon-draw` (SVG stroke khud ko "likhta" hai), `icon-pop` (tile
  icon halka bounce), `icon-spin-slow` (loading), `dot-blink` (live dot), `chevron-nudge`
  (dabane par `›` aage), `check-pop` (delivered ✓). `prefers-reduced-motion` par sab band.
* **Group cart card** — icon tile + title + asli `role="switch"` toggle (46×27, `aria-checked`).
  Toggle off karne par card halka fade hota hai, par **import button hamesha saamne rehta
  hai** (round 17 ka niyam: import button ke pehle koi dropdown nahi).
* **Address row** — pin icon + `DELIVERING TO` + naam/address + `›`, poora row tappable.
* **Payment tiles** — 3 tiles (UPI/QR selected green radio + tick, Card & COD faded +
  "Not available"). Bill aane se pehle right side par **"Updating" spinner pill** — jhooth
  nahi, bas sach: abhi quote aa raha hai.
* **Pay bar** — `PAY USING UPI` + amount (`--t-20`) + `PAY NOW` pill.
* **Coupon sheet** — head me "Apply Coupon" + close icon-button; `AVAILABLE COUPONS n`;
  applied ribbon; har coupon par APPLY.
* **Delivered hero** — bada green check (`check-pop`) + "Order Delivered" + `Back to Orders`
  pill, upar dono action pills. Sirf jab Swiggy ka status `delivered` ho aur "out for
  delivery"/"on the way" na ho — warna purana honest card hi dikhta hai.
* **Chhote phone** — `@media (max-width: 380px)` par padding `12px`, kuch bahar nahi jaata.

### Kya copy NAHI kiya — aur asli wajah
1. **Coupon code type karne wala input** — reference me hai, par boss ka round-9/49 niyam
   pakka hai: *"coupon available nahi hai" mat bolo, list dikhao, sirf APPLY buttons*. Code
   box wapas laane se log haath se galat code daal ke "coupon nahi laga" ka shor karte hain.
   Isliye list + APPLY rakha. (Test v96 isi ko pakadta hai — `input[name="coupon"]` = null.)
2. **"Incognito" / "order history 3 ghante me delete"** — ye Swiggy ke andar ka feature hai.
   Hum usse chala nahi sakte, aur nakli toggle banane ka matlab jhooth hota. **Nahi kar sakta.**
3. **Card / COD ko chalu dikhana** — hum sirf UPI se paisa lete hain. Tile dikhta hai
   (reference jaisa) par faded + "Not available". Chalu dikhana = customer ka paisa atakna.
4. **Group-cart ka data hum khud nahi bana sakte** — button asli `cart/import` chalata hai;
   juicetext/OCR ka natija wahi dikhta hai jo Swiggy deta hai.
5. **Swiggy ka logo/font-as-is** — Manrope (open font) reference jaisa feel deta hai;
   unka brand logo uthana legal aur pehchaan dono ka issue hai.

### Tests
`test_v117_reference_visual_system.mjs` **9 checks** — tokens, card rhythm, 6 icon
animations, switch/address/pay-tile/pay-bar/delivered-hero CSS, ≤380px media, aur DOM:
toggle chal raha hai + import button saamne, address row, payment tiles + Updating pill,
delivered hero + Back to Orders pill.
Sweep: guards **85/85 (157s)**, `npm test` **132/132**, `test:pro` **41/41**.

---

## Round 29 — "Ek page me saari information", koi lecture nahi

Boss: *"USKA BOT KITNA PRECISE HAI AND TERA WALA KITNA BEKAR HAI — EK PAGE ME SAARI
INFORMATION WO DE RAHA, TU USER KO BATATE BATATE DAM TOD DE RAHA."*

Sach: cart page par 1,939 characters text tha — bill ka poora plain-text copy **dobara**
dikhta tha, aur har card ke neeche ek paragraph samjhata tha ki app kaise chalta hai.
Ab visible text **1,305 characters** hai aur kaam ki har cheez **ek hi page** par hai.

### Kya badla
* **Duplicate bill gone** — `<pre class="bill-plain">` ab `hidden` rehta hai, `Poora hisaab`
  dabane par khulta hai. (Text DOM me hai — copy/verify ke liye — par screen par wall nahi.)
* **Coupons usi page par** — SAVINGS CORNER me 3 coupon rows + **APPLY**, aur
  `Saare coupons (n)`. Cart khulte hi list khud load hoti hai (`maybeAutoCoupons`, same
  restaurant ke liye ek hi baar — loop nahi). Page badalne ki zaroorat nahi.
* **Lecture lines hatayi** — "Neeche Pay Now dabane par Swiggy ek asli order request
  banata hai…", "Share link, swiggy.com/gc/…", "Swiggy se aaya bill…", payment card ki
  poori paragraph, "Balance poora hai — Pay dabate hi…".
* **2-minute rule** — text wahi (sach chhupaya nahi), par pay bar ke andar **ek chhoti
  chip** (`.pay-bar .idle-note`), page ke beech me paragraph nahi.
* **ETA strip** se duplicate "Deliver to <address>" pill hataya (neeche address row
  pehle se hai). Savings banner ab `✨ ₹28 saved! · CODE` — bas.
* **Wallet card** — "Kitna paisa bhejna hai?" ab ek line: *UPI mius@ybl par bhejein,
  12-digit UTR daaliye — jitna paisa sach me aaya utna hi judega.* (Sach wahi, shabd kam.)
* **Payment tiles** — `Visa, Mastercard, RuPay · app se nahi` / `Not available — UPI se
  pay karein`. Card chalne ka dikhawa nahi.

### Kya nahi chheda (jaan-boojh kar)
* UTR credit ka sach, fee ka sach, "kaunsi UPI par paisa jata hai", delivery OTP warning,
  operator-ID restriction — ye **chhupane wali cheezein nahi** hain. Inhe chhota likha,
  hataya nahi. (v105/v112/v100 ke tests inhi shabdon ko pakadte hain.)

### Tests
`test_v118_one_page_no_lecture.mjs` **5 checks** — bill plain-text hidden + ek tap par
khulta hai; coupons inline + APPLY se asli `cart/sync`; purani lecture lines gayab;
6 zaroori blocks ek page par; visible text < 1500 chars; idle chip pay bar me.
Sweep: guards **86/86 (160s)**, `npm test` **132/132**, `test:pro` **41/41**.

---

## Round 30 — asli browser se screenshot QA, aur jo screenshot ne pakda

Boss: *"high-fidelity replication + run it, inspect it, compare it, correct it."*
Is baar **asli Chromium** me app chala kar PNG liye — aur usme **4 bug** mile jo code
padh kar nahi dikhte.

### Screenshot harness (naya)
* `npm run preview:miniapp` (port 4173, demo data) + `npm run shots:miniapp`
  → `screenshots/01…10-*.png` (390×844 @2x, deviceScaleFactor 2).
* Browser: `puppeteer-core` + `@sparticuz/chromium`. Is image me `libnss3` nahi hoti,
  isliye `tools/chromedeps/setup.sh` ek **screenshot-only NSS stub** banata hai (preview
  HTTP hai, TLS kabhi nahi chalta). Libs git me nahi jaati (`.gitignore`).
* Har screenshot 20s par timeout deta hai — headless-shell kabhi atak jata hai, warna
  poora harness hang ho jata tha (isko bhi QA me pakda).

### Screenshot ne jo bug pakde (aur fix)
1. **Emoji tofu** — savings banner me `✨` box ban raha tha (device par emoji font nahi).
   Ab apna SVG `spark` icon. `test_v119` guard karta hai.
2. **Khaali ₹ buttons** — wallet presets `[1500, 5000]` (numbers) aate hain par UI
   `{paise, rupees}` object maangta tha → button par sirf `₹`. Ab dono shape chalti hain.
3. **Address heading** — `DELIVERING TO` ke neeche "Delivery address" (generic) dikh raha
   tha. Ab asli naam (`Skk`), fallback honest.
4. **Coupon sheet side me khisak raha tha** — `translateX(-50%)` par `sheet-rise` keyframes
   ka `transform` chadh raha tha, sheet aadhi screen ke bahar + backdrop nav block kar raha
   tha. Ab `left:0;right:0;margin-inline:auto` (transform-free) — screenshot ne dikhaya,
   fix ke baad wapas capture kiya.
5. **Backdrop blur** headless-shell ka compositor atka deta tha (orders/tools screenshots
   timeout). Backdrop ab blur-free solid dim — dekhne me same, render saaf.

### Naya screen/structure jo reference me tha
* **Coupon bottom sheet** — dimmed cart peeche, grip, head, close (Rule 3C). Band karne ke
  raste: X, backdrop tap, back button.
* **Orders filter** — `This Account` / `Last 1 Hour`. Count **sirf** tab jab Swiggy ne
  parse-hone wala time diya ho; warna button disabled + `title` me asli wajah
  ("Swiggy ne order ka time nahi diya…"). Jhoota count kabhi nahi.
* **Order detail bill** — payment method, receiver, delivery partner (jab provider de),
  platform/subscription/coupon/offer/tax lines **sirf** jab data ho, aur `Total paid`.
  Data na ho to saaf likha: "Swiggy ne line-by-line bill nahi diya — sirf total."
* `main` ka bottom clearance badhaya — fixed cart dock ke neeche kuch permanent na chhupe.

### Verification
* `npm run shots:miniapp` → 10 screens, phir **dobara** capture (fix ke baad) — 320/360/
  390/414 px par horizontal overflow check (sab `ok`, koi element viewport se bahar nahi).
* guards **87/87 (155s)**, `npm test` **132/132**, `test:pro` **41/41**.
* naya guard: `test_v119_visual_qa_fixes.mjs` **8 checks**.

### Limitations (sach)
* Reference PNGs repo me nahi hain (boss ke phone se aate hain) — isliye "pixel-diff"
  reference ke against nahi ho saka. Jo compare hua wo: render vs. documented inventory
  (`docs/REFERENCE_INVENTORY.md`) aur render vs. pichhle round ke screenshots.
* Swiggy ka asli app is machine par nahi khulta; cart ka data demo hai.

---

## Round 31 — Accounts screen reference jaisa + "copy JSON" asli

Boss: *"ISKO AS IT IS COPY KAR — FONT SIZE, SPACING, ID AND ALL THE FEATURES IT PROVIDE
LIKE WHEN CLICK COPY THE JSON."*

Reference PNG (692 px wide = 390 CSS px, scale 1.79) se naap nikaal kar screen dobara banayi.

### Screen (naap `docs/REFERENCE_INVENTORY.md` §2 me)
* Topbar chhota (60px), brand tile 38, **PRO** badge, chip me person icon + number,
  theme button icon (pehle `☾` text tha — ab SVG).
* **Add Account** card: `Add Account` + **Number / JSON** pill toggle, `Mobile Number`
  label, input me **CSS tiranga** + `+91` (emoji nahi — emoji font na ho to tofu), gradient
  **Send OTP** with send icon.
* **Saved Accounts** heading + hairline + count pill, **Search Account...**, phir rows:
  avatar tile, naam, `+91 number`, aur right side **Used** pill → **copy JSON** →
  **green check** (select) → **delete**.
* Har row real data se banti hai (`used` = active/USED, blocked row faded, shared ID par
  "Claim: sirf operator"). Koi fake row nahi.

### Copy JSON — dikhawa nahi, asli
* Naya route `GET /pro/api/accounts/session?key=…` — **wahi** JSON deta hai jo
  `/accounts/import` wapas leta hai (internal flags jaise `isLoggedIn` hata kar).
* Sirf apna account: shared/vault ID par non-boss ko **403**, token response me aata hi
  nahi (test isko pakadta hai). Rate limit `accountExport` = 30/hour.
* UI: `navigator.clipboard.writeText` → na ho to `textarea + execCommand` fallback →
  dono fail ho to **laal toast** ("copy nahi ho paya"), chup-chaap kuch nahi.
* Live browser me verify: clipboard me asli JSON gaya, toast `✓ skk ka JSON copy ho gaya.`

### Search
Client-side filter (naam **ya** number se), re-render ke bina — isliye typing par keyboard
band nahi hota. Koi match na ho to line dikhti hai.

### Chhoti cheezein jo saath theek hui
* Free-cash emoji (`💵`) hata kar text — emoji tofu risk tha.
* Offer chip me emoji sirf tab jab server de; warna chhota dot (🎁 fallback hata).

### Verification
* `npm run shots:miniapp` → accounts screen **do baar** capture ki, farak dekh kar spacing
  chhoti ki (title ek line me, actions 26px, hint ek line).
* Live Chromium: copy JSON, toast, search filter — sab chalte dekhe.
* naya guard `test_v120_accounts_reference_and_copy_json.mjs` **12 checks** (DOM 9 + server 3).
* Sweep: guards **88/88 (148s)**, `npm test` **132/132**, `test:pro` **41/41**.

### Nahi kiya (sach)
* Reference me "JSON" tab par click karne ka screenshot nahi tha — hum wahi session-import
  form dikhate hain jo pehle se tha (asli verify hota hai).
* Copy JSON me token jata hai — isliye note bhi saath: "Kisi ke saath share na karein."

## Round 32 — 5 minute verify + share link

* QR aane ke baad `renderCart()` khud `schedulePaymentPoll()` chalata hai: pehla check **5s**,
  phir har **5s**, poore **5:00** tak. Countdown `[data-pay-clock]` par (`m:ss`) — sirf text
  badalta hai, page re-render nahi hota, isliye QR flash nahi karta.
* Payment `PAID` aaya → `openOrdersForOrder(orderId, { share: true })`: My Orders tab khulta
  hai, wahi order khud khulta hai aur `orders/tracking` se Swiggy ka share link aa jata hai.
* 5 minute poore → strip `expired` ho jati hai ("5 minute poore ho gaye") aur Payment check
  button aa jata hai. Spinner chhupta nahi — sach likha jata hai.
* Share card (order detail + track screen dono me): readonly link, **Copy link**, **Telegram
  par share** (`https://t.me/share/url?url=…`). Mini app ke andar se browser nahi khulta
  (purana guard abhi bhi lagu) — Telegram API na ho to link copy hota hai aur saaf toast aata hai.
* Swiggy link nahi deta → "Swiggy ne is order ka share link nahi diya… Hum apna link nahi
  banate" + Refresh. Kabhi bhi apna banaya link nahi.
* Guard: `test_v121_five_minute_verify_and_share_link.mjs` **7 checks**. Sweep: guards
  **89/89**, `npm test` **132/132**, `test:pro` **41/41**.
* Preview me dekhne ke liye: `npm run preview:miniapp` → `?scene=paypending` (QR + verify
  strip) aur `?scene=share` (share card).

## Round 33 — payment page, bill speed, filters

* Payment page par sirf do button: **I have paid** (`checkout-status`) aur **Cancel order**
  (`checkout/cancel`, confirm ke baad; wallet fee wapas, cart wapas). `Open UPI app` hata diya —
  mini app se bahar navigation purane guard se bhi band hai.
* Paid hone par seedha **My Orders → wahi order**, share link + **Copy** + **Go back** (Go back
  se normal cart page).
* Bill do kadam me: `cart/sync` ab **fast** phase (asli bill turant), phir `cart/optimize`
  (offers + One Lite + best coupon). `bill-refresh`/`checkout-start` poora bill ek saath lete
  hain (`phase: 'full'`). Default (provider) poora hi rehta hai — koi caller toota nahi.
* Bill ka hisaab: available Swiggy Money discount nahi (sirf jo kata), campaign free cash ek
  hi line, residual GST me kata hua wallet joda.
* Accounts filter chips: `USED / FRESH / NIGHT / BREAKFAST` + count, multi-select + Clear.
* Guard: `test_v122_round33_payment_actions_bill_speed_filters.mjs` **9 checks**.
  `npm test` **132/132**, `test:pro` **93/93**.
* **Round 34 (checkout tez + Pay Now clock):** 2 minute ka window ab **bill fetch hone ke baad**
  shuru hota hai (`cart.quote.fetchedAt`); bill aane se pehle kuch saaf nahi hota (15 min purana
  adhoora draft phir bhi saaf). Pay Now ke bagal live clock `● m:ss` (30s bache par laal, khatam
  par "Time up"). Patli `#loadbar` sweeping animation hata di; bill ke liye `.bill-loading`
  "receipt print" card. Bill tez: address-confirm cache (10 min, fingerprint match),
  cart-write ke jawab se readback, fast phase timeout 7s.
* Guard: `test_v123_round34_bill_faster_pay_window.mjs` **12 checks** (`npm run test:round34`).
  `npm test` 132/132, `test:pro` 93/93, `run_guards` 77/91 (14 = wahi purane env/network suites
  jo `origin/main` par bhi fail hote hain; `test_v102` ab pass — pehle baseline me fail tha).
* **Round 35 (cancel saaf + bill consistent + free cash):** uncertain checkout ka "needs checking"
  card gaya — ab `.cancel-card` sirf **Order cancel karein** (fee wapas, cart wapas, order dobara
  ho sakta hai). Bill do-kadam (fast → optimize) hata diya: **ek hi poora bill**, jo Pay bar par
  dikha wahi `expectedTotal` ban kar checkout jata hai. Offer claim ka jawab cart push se pehle
  liya jata hai, isliye free cash/night cash usi bill me aata hai; bill card par claim ka sach
  (`offerNote`) dikhta hai.
* Guard: `test_v124_round35_cancel_and_consistent_bill.mjs` **8 checks** (`npm run test:round35`).
  `npm test` 132/132, `test:pro` 93/93, `run_guards` 78/92 (14 = wahi purane env/network suites).
