# Possibility Matrix — "pehle saari possibilities block karo"

Boss (31-10-2026, round 17):

> "BHAI DEKH KOI BHI KAAM KARNE SE PEHLE KITNI POSSIBILITIES HOSAKTI SABKO IDENTIFY KARKE BLOCK KARDIA KAR NA"

Ye file wahi list hai: **kaun kaun si galat cheez ho sakti hai, uska block kahan hai, aur
kaunsa test use pakadta hai.** Naya kaam karne se pehle `node test_v106_possibility_matrix.mjs`
chalta hai — koi purana darwaza khula na reh jaye.

Legend: ✅ = block + test · ⚠️ = block hai par provider/bank par depend karta hai (sach likha jata hai)

---

## A. Paisa (wallet / UTR)

| # | Possibility (kya galat ho sakta hai) | Block | Kahan |
|---|---|---|---|
| A1 | UTR khaali chhod kar "paisa bhej diya" | `UTR_REQUIRED` — koi credit nahi | `swiggy-pro-api.js` claimWalletTopup |
| A2 | UTR ka format galat (3 digit / letters only) | `UTR_INVALID` (12 digit UPI UTR) | same |
| A3 | Wahi UTR dobara, usi user se | `DUPLICATE_UTR` | `user-wallet.js` `usedUtrs` ledger |
| A4 | Wahi UTR dobara, **dusre user** se | `DUPLICATE_UTR` + "kisi aur ke top-up me use ho chuka" | same (global ledger) |
| A5 | Purane topup records prune hone ke baad wahi UTR | permanent ledger prune nahi hota | `user-wallet.js` `cfg()` / `markUtrUsed` |
| A6 | "Jitna bol raha" — amount khud likhna | credit **sirf top-up intent ke amount** par; alag amount → `TOPUP_AMOUNT_MISMATCH` (dono numbers) | `swiggy-pro-api.js` |
| A7 | Bina top-up QR ke claim | `NO_TOPUP_INTENT` | same |
| A8 | Ek top-up QR se kai claims | intent `usedAt` par band, ek baar | same |
| A9 | Bada amount bina bank verify auto-credit | ₹15 (fee) se zyada → **PENDING**, boss approve karega; `creditedPaise: 0` (jhootha credit nahi) | `WALLET_AUTO_CREDIT_MAX_PAISE` (default 1500) |
| A10 | Claim spam / UTR guessing | rate limit 10/hour → `RATE_LIMITED` + kitne minute baad | `pro-rate-limit.js` |
| A11 | Top-up spam / ek user ke kai khule intent | 20/hour + naya top-up purana band karta hai | same |
| A12 | Negative / zero / NaN amount | ₹1–₹500 clamp, `amountPaiseFromBody` | `swiggy-pro-api.js` |
| A13 | ₹0.005 jaisa fractional paise | `exactPaise()` integer-paise check | `swiggy-cart-integrity.js` |
| A14 | ⚠️ Paisa sach me aaya ya nahi (bina bank/provider API) | provider verify set hone par wahi source of truth; warna ledger me **`verifiedBy: 'user-claim'`** sach likha jata hai | `submitTopupRequest` |

## B. Order / payment QR

| # | Possibility | Block | Kahan |
|---|---|---|---|
| B1 | Fake/placeholder QR (`swiggy@icici` etc.) | exact fake handles blocked | `payment-qr-guard.js` |
| B2 | QR amount ≠ bill | block + dono numbers ("QR ₹58, bill ₹48") | same |
| B3 | Swiggy `am` + `amount` ka jhagda (QR hi na aaye) | `amount` drop / bill wala amount chuna jata hai | round 16 |
| B4 | Gandi encoding (`&amp;`, duplicate param, space) | auto-fix + warning, QR nahi rukta | round 15 |
| B5 | Order place ho gaya par QR nahi | Swiggy ke apne payment page se ek baar recovery; warna `PAYMENT_PENDING` + asli wajah, dobara place nahi | `swiggy-pro-provider.js` |
| B6 | Double order place (retry) | placement journal, `executeSingleSwiggyPlacement` | `swiggy-placement-journal.js` |
| B7 | Bar-bar place / checkout spam | 6 per 15 min → `RATE_LIMITED` | `pro-rate-limit.js` |
| B8 | Cart tampering (price/qty) | server cart + Swiggy live cart compare | `sameCartItems` |
| B9 | Coupon bill me alag, Swiggy par alag | `COUPON` mismatch par order nahi | `swiggy-pro-provider.js` checkout |
| B10 | Address/receiver badalna | same receiver phone + near coordinates, warna block | `sameDeliveryRecipient` |
| B11 | Wallet balance ke bina order | `WALLET_LOW_BALANCE`, provider tak baat nahi jati | `swiggy-pro-api.js` |
| B12 | Fee double charge | idempotent `chargeServiceFee` | `user-wallet.js` |
| B13 | Place na hone par fee na wapas | `refundServiceFee` sirf place-not-done par | same |
| B14 | Ek ID se do order (do log) | per-account lock + ID lock until deliver/cancel | `order-account-lock.js` |
| B15 | Draft hamesha ke liye ID pakde rehna | 2 minute idle sweep | `order-idle-expiry.js` |

## C. Swiggy ID / session

| # | Possibility | Block | Kahan |
|---|---|---|---|
| C1 | Vault (operator) ka ID private workspace me copy | `ACCOUNT_ALREADY_MANAGED` (ek ID = ek order) | `swiggy-pro-api.js` import |
| C2 | Import spam / galat session JSON | 8 per hour → `RATE_LIMITED` | `pro-rate-limit.js` |
| C3 | OTP spam (Swiggy SMS) | 8/hour request, 15/15min verify | same |
| C4 | JSON me phone badal kar doosra account | verified phone mismatch → 400 | import/verify |
| C5 | Busy/suspended ID se order | select hi block | `accounts/select` |
| C6 | Order ke beech ID switch | checkout pending hone tak switch band | same |
| C7 | Delete without Swiggy OTP | delete-OTP zaroori (DB only / Swiggy dono raste) | `accounts/remove*` |
| C8 | Boss ka UPI user badal de | 403 boss-only | `wallet/upi` |
| C9 | Doosre user ka tracking/address | `SHARED_ACCOUNT_RESTRICTED` | `orders/tracking` |
| C10 | Backup ka jhootha dawa | sirf boss backup kar sakta hai, sach status | `backup` |

## D. Offers / coupons

| # | Possibility | Block | Kahan |
|---|---|---|---|
| D1 | Ek offer do baar claim | `ensureCampaignClaim` ledger (read-back verified) | `event-offers.js` |
| D2 | Offer claim spam | 20/hour | `pro-rate-limit.js` |
| D3 | Coupon jhootha "lag gaya" | winner sirf jab asli bill kam ho; warna asli reason | `swiggy-pro-provider.js` |
| D4 | One Lite mehnga pad jaye | net-savings check + revert | same |

## E. Data / truth

| # | Possibility | Block | Kahan |
|---|---|---|---|
| E1 | Rate limit chhup jaye | bootstrap me `rateLimits` snapshot | `swiggy-pro-api.js` |
| E2 | Generic "kuch galat ho gaya" | har error me code + asli wajah | `KNOWN_CODES` |
| E3 | QR intent ka kachra dobara na pata chale | `diag.intentRaw` (400 chars) | `swiggy-pro-provider.js` |

## F. Bill calculation ki har possibility (round 18, `bill-reconcile.js`)

| # | Possibility | Kya hota hai |
|---|---|---|
| F1 | Bill hi nahi aaya (null / string / number) | `BILL_MISSING`, koi number invent nahi |
| F2 | `"₹1,234.50"`, `"1 234.5"`, `"Rs 1234"` string money | parse hota hai (`toMoney`) |
| F3 | `NaN` / `abc` / khaali | us line ko chhoda jata hai + note |
| F4 | Negative value (`-20` delivery) | 0 + `BILL_NEGATIVE_VALUE` note |
| F5 | 3+ decimal (10.555) | 2 par round + note |
| F6 | `total` missing | lines se derive + `BILL_TOTAL_MISSING` (derived bata kar) |
| F7 | `itemTotal` missing | items ka jod + `BILL_ITEM_TOTAL_DERIVED` |
| F8 | Total lines se **zyada** (chhupa charge) | limit (₹20/15%) ke andar `otherCharges`, bahar `BILL_DOES_NOT_ADD_UP` |
| F9 | Total lines se **kam** (chhupi saving) | `unlistedDiscount` — darawni warning nahi (boss ka purana rule) |
| F10 | Approved total badal gaya | `BILL_TOTAL_CHANGED` + dono numbers |
| F11 | Free cash payable se zyada | clamp + `BILL_FREE_CASH_OVER_PAYABLE` (negative total nahi) |
| F12 | Coupon "laga hua" par discount 0 | coupon line hatai jati hai + note |
| F13 | Coupon ka discount item total me already shamil | alag line nahi (`discountAlreadyApplied`) |
| F14 | Packing GST ke andar | double nahi jodta + note |
| F15 | One Lite fee par delivery FREE nahi | `BILL_ONE_FEE_WITHOUT_FREE_DELIVERY` note (nuksaan saaf) |
| F16 | Delivery FREE par saving 0 | `BILL_DELIVERY_FREE_NO_SAVING` — 0 hi dikhta hai |
| F17 | Subscription item hai par fee 0 | note, One Lite line nahi |
| F18 | To Pay ₹0 | `BILL_ZERO_TOTAL` |

## G. QR generation ki har possibility (round 18, `qr-generation-plan.js`)

| # | Possibility | Kya hota hai |
|---|---|---|
| G1 | Provider ne intent nahi diya | payment page se recovery, phir bhi nahi → saaf wajah |
| G2 | Escaped/kachra (`&amp;`, `\u0026`, duplicate, space) | normalize + auto-fix warning |
| G3 | `am` + `amount` value alag | bill se match karne wala amount chuna jata hai |
| G4 | Intent `https://…` page link | block — "web page ka link hai, UPI intent nahi" |
| G5 | Placeholder/fake VPA (`swiggy@icici`) | block + wajah |
| G6 | Amount bill se alag | block + dono numbers |
| G7 | Amount missing / 0 / 3 decimal | block |
| G8 | `cu` non-INR | block |
| G9 | Duplicate param alag value | block |
| G10 | Intent bahut lamba (1200 chars) | block — QR scan nahi hoga |
| G11 | Kai sources (provider + page) | pehla valid jeetta, har reject ki wajah rakhi jati hai |
| G12 | Wahi intent do baar | duplicate skip |
| G13 | QR image bani par PNG nahi/khaali | render se pehle `isRenderableQrImage` block |
| G14 | Kuch bhi valid nahi | `ok:false` + HAR wajah (`reasons[]`, max 6) |

Bill ka poora sach quote me `checks` / `problems` / `notes` / `billState` ke roop me jaata hai;
QR ka sach `qrSource` + `qrPlan` me.

---

## Kaise chalte hain

```bash
node test_v106_possibility_matrix.mjs     # matrix ka smoke
npm run test:guards                       # poora sweep (73+ suites)
```

Limit badalni ho to ek hi jagah: `pro-rate-limit.js` → `RATE_LIMITS`.
Auto-credit cap: env `WALLET_AUTO_CREDIT_MAX_PAISE` (default `1500` = ₹15).

## Jo abhi bhi provider par depend karta hai (chhupaya nahi)

* Paisa bank me aaya ya nahi — bina `UPI_UTR_VERIFY_URL` provider ke confirm nahi hota; tab
  ledger me `verifiedBy: 'user-claim'` likha jata hai aur bada amount boss approval par jata hai.
* Swiggy kabhi-kabhi place-response me intent hi nahi bhejta — tab payment page se recovery,
  warna `PAYMENT_PENDING` + order ID (order cancel Swiggy khud karta hai).

---

## H. Deploy-proof paisa/UTR + tracking link + auto-fetch (Round 19)

Boss: *"SAME UTR MENE DAALA TO HOGAYA KIUKI DEPLOY KARNE PAR SARA DATA RESET HOJATA HAI"*,
*"TRACKING LINK BHI NAHI AARAHA"*, *"ORDER PAYMENT KARNE KE BAAAD AUTO FETCH BHI NAHI HORAHA"*.

### H — paisa/UTR ka har case

| # | Case | Behaviour |
|---|---|---|
| H1 | `db.json` deploy par naya (`ensureDb` reseed) | boot par snapshot se merge — wallet + `usedUtrs` wapas |
| H2 | Cloud token nahi | local disk copy; status line **saaf** bolti hai "Cloud backup OFF" |
| H3 | Snapshot me balance kam, local me zyada | local jeetta hai — paisa **kabhi** kam nahi |
| H4 | Snapshot me UTR hai, local me nahi | UTR jud jata hai (dobara claim nahi) |
| H5 | Local me UTR hai, snapshot me nahi | local rehta hai (union, delete nahi) |
| H6 | Snapshot duplicate/again push | union idempotent — `changed:false`, jhootha "restore hua" nahi |
| H7 | Snapshot khaali | push skip (`empty`), restore kuch nahi badalta |
| H8 | Vault file encrypted | AES-256-GCM; bina `VAULT_ENCRYPTION_KEY` decrypt nahi — status me wajah |
| H9 | Cloud me UTR plaintext | **never** — test snapshot file me UTR string dhoondta hai |
| H10 | Push fail / net gaya | throttled retry, `lastError` status me; boot kabhi block nahi |
| H11 | Process `SIGTERM` | shutdown se pehle ek force flush |

### H — tracking link

| # | Case | Behaviour |
|---|---|---|
| H12 | Shared/operator ID | 200 + `trackingUrl` (Swiggy), status, ETA — `restricted: true` |
| H13 | Shared ID par private detail | `deliveryOtp` = `''`, `deliveryPartner` = `''` — leak nahi |
| H14 | Provider `swiggy://share?text=<https…>` | https link nikaal kar diya jata hai |
| H15 | Provider ne link nahi diya | `trackingUrl: ''` + saaf note "refresh se status aata rahega" |
| H16 | Doosre order ka link | `safeTrackingUrl` reject (order id mismatch) |
| H17 | Paid checkout restricted user | `publicCheckout` link deta hai, OTP/rider nahi |

### H — auto-fetch

| # | Case | Behaviour |
|---|---|---|
| H18 | Payment ke baad button nahi dabaya | app khud 8s baad `checkout/status`, phir har 12s |
| H19 | 30 try ke baad bhi pending | poller ruk jata hai (battery/net), button bacha rehta hai |
| H20 | `PAID` mil gaya | tracking khud khulta hai + toast |
| H21 | Draft idle band / naya draft | poller band, counter reset |

---

## I. Wallet credit = asli paisa (Round 20)

Boss: *"JAB CHOTA AMOUNT DAAL KAR RANDOM KOI BHI UTR DAALTA WO ADD HO JATA ... UTR PAR JITNA
AMOUNT JAYE AGAR WO MISBAHUL ISLAM HO UTNA ADD HOJAYE"*.

Pehle provider set na hone par `submitTopupRequest` sirf "UTR unique hai" dekh kar credit kar deta
tha — ₹1 ka random UTR bhi wallet me jud jata tha. Ab credit ka faisla `upi-credit-policy.js`
(pure) karta hai, aur sabooot sirf do jagah se aata hai: **bank/UPI statement** (`upi-statement.js`)
ya **provider verify API**.

| # | Case | Behaviour |
|---|---|---|
| I1 | Random UTR, koi payment record nahi | PENDING — balance me **kuch nahi** |
| I2 | Statement me UTR hai, paisa Misbahul Islam ko aaya | CREDIT — **jitna aaya utna** |
| I3 | Claim ₹500, statement ₹15 | ₹15 judta hai (claim ka amount nahi) |
| I4 | Claim ₹15, statement ₹500 | ₹500 judta hai + note "poora asli paisa juda" |
| I5 | Statement me payee koi doosra (RAHUL KUMAR) | REJECT `PAYEE_MISMATCH`, claim reject, paisa nahi |
| I6 | Payee naam spelling variants (Md Misbahul Islam / MISBAHUL) | accept (token match) |
| I7 | Payee VPA `mius@ybl` | accept (VPA match) |
| I8 | Payment FAILED / PENDING / REVERSED / debit line | REJECT `PAYMENT_NOT_SUCCESSFUL` |
| I9 | Aaya amount ₹1 se kam | REJECT `AMOUNT_TOO_LOW` |
| I10 | Statement me amount missing | REJECT `AMOUNT_NOT_RETURNED` |
| I11 | UTR mismatch (statement ka UTR alag) | REJECT `UTR_MISMATCH` |
| I12 | Wahi UTR dobara (kisi bhi user ka) | 409 `DUPLICATE_UTR` / `UTR_ALREADY_USED` |
| I13 | Payment top-up QR banne se 10 min pehle ka | PENDING `PAYMENT_BEFORE_INTENT` |
| I14 | Verified par amount `WALLET_AUTO_CREDIT_MAX_PAISE` (₹15) se zyada | PENDING — boss approve karega |
| I15 | Statement entry dobara import | idempotent (UTR unique), double paisa nahi |
| I16 | Boss statement paste karta hai, pending claim match hua | claim auto-settle **asli amount** par, ledger me credit |
| I17 | Boss statement paste karta hai, payee galat | claim REJECTED, wajah naam ke saath |
| I18 | Non-boss statement import | 403 |
| I19 | Statement line me debit/failed/reversal | parse hi nahi hoti |
| I20 | Provider API verified + amount + payee | CREDIT asli amount (provider payment record) |
| I21 | Webhook (signed) se paisa | statement ledger me record + credit webhook amount |

Statement import: boss mini-app → Tools → **UPI statement (asli paisa)** → lines paste → import.
Format kuch bhi chalta hai jisme 12-digit UTR + ₹amount ho, jaise
`31-10-2026 UPI/CR/123456789012/MISBAHUL ISLAM/₹15.00 credited`.

Badalne wale env: `UPI_PAYEE_NAME` (default `MISBAHUL ISLAM`), `UPI_PAYEE_VPA` (default `mius@ybl`),
`UPI_UTR_VERIFY_URL` + `UPI_UTR_VERIFY_TOKEN` (provider verify), `WALLET_AUTO_CREDIT_MAX_PAISE`.

---

## J. Tracking aur SMS ka sach (Round 21)

Boss: *"NO SMS RECEIVED AND NO TRACKING IS AVAILABLE"*.

### J — tracking (har rasta, phir bhi na mile to sach)

| # | Case | Behaviour |
|---|---|---|
| J1 | `trackV4` me `fyi_details[].cta_link` | link mila, `via: FYI_CTA` |
| J2 | trackV4 khaali, `order/details` me link | link mila, `via: ORDER_DETAILS` |
| J3 | DAPI dono khaali, Swiggy order page (`__NEXT_DATA__`) | link mila, `via: WEB_PAGE_SHARE` |
| J4 | `swiggy://share?text=<https…>` share URI | https link nikaal kar diya |
| J5 | 3 try ke baad bhi kuch nahi | `TRACKING_NOT_PUBLISHED` + `tried[]` + asli wajah |
| J6 | Operator/shared ID | link + status + ETA; OTP/rider/naam chhupe |
| J7 | Doosre order ka link | `safeTrackingUrl` reject |
| J8 | App: order kholte hi | tracking khud load (Refresh dabana nahi) |
| J9 | App: link na mile | "kya try hua" + Refresh ka asli reason |

### J — SMS (jhooth bina)

| # | Case | Behaviour |
|---|---|---|
| J10 | Swiggy payload me `sms_sent: true` (ya `SMS_SENT`) | `SENT` + evidence path |
| J11 | `sms_sent: false` / `SMS_FAILED` | `NOT_SENT` + evidence |
| J12 | Koi flag nahi | `UNKNOWN` — "proof nahi", jhootha "bhej diya" nahi |
| J13 | Receiver ka number = account ka number | saaf: Swiggy alag SMS nahi bhejta |
| J14 | Order "someone else" ke roop me nahi gaya | saaf: recipient SMS ka wada nahi |
| J15 | OFO bheja par Swiggy ne confirm nahi kiya | saaf wajah (SMS/link isi wajah se nahi) |
| J16 | OFO confirm par koi SMS flag nahi | `UNKNOWN` + wajah |
| J17 | Environment me live order band (`SWIGGY_BLOCK_LIVE_ORDER_PLACE=1` / sandbox) | boss card me "Live order BAND" + wajah |
| J18 | Receiver ka number hi nahi mila | "number hi wapas nahi diya" |

Har order par `receiverPhone`, `forSomeoneElse` checkout ke waqt hi yaad rakhe jaate hain
(`ws.checkout.receiverPhone`), isliye SMS ka sach baad me bhi asli number par banta hai.
UI me `receiverMasked` hi dikhta hai (`79••••9775`), poora number nahi.

---

## K. Login ID ka data deploy par kaise bachta hai (Round 22)

Boss: *"AB JAISE JITNE BHI LOGIN ID HOTE HAIN KISKA DATA NAHI BACHTA WO KISLIYE AND KYA SOLUTION HAI"*.

**Kisliye:** `store.js` ka `ensureDb()` `db.json` na mile to `defaultData` bana deta hai. Render par
disk attach na ho (ya redeploy par khali ho) to login IDs ke cookies/token, `sessionVault`,
mini-app workspaces (address/cart/orders) — sab ek deploy me gayab. Round 19 me **paisa** ka
snapshot bana tha, **IDs** ka nahi.

**Solution:** `identity-snapshot.js` (pure) + `db-durability.js` ka identity backup/restore.

| # | Case | Behaviour |
|---|---|---|
| K1 | Deploy par `db.json` naya | boot par identity snapshot se saari IDs wapas (`restoredFromSnapshot`) |
| K2 | Local me live session, snapshot purana | local jeetta hai — naya session overwrite nahi hota |
| K3 | Local copy dead (cookies khaali / expired) | snapshot wali zinda session wapas aati hai |
| K4 | ID jaan-boojh kar logout/delete | tombstone — kabhi resurrect nahi |
| K5 | sessionVault (purane OTP sessions) | union — koi bhi na jaata |
| K6 | Mini-app workspace (address/cart/orders) | snapshot me envelope, boot par disk file wapas |
| K7 | Local workspace zinda hai | snapshot se overwrite nahi hota |
| K8 | Cloud token nahi | local copy (`db-identity-snapshot.json`), status line saaf warning |
| K9 | Cloud me plaintext cookies | kabhi nahi — AES-256-GCM |
| K10 | 1.5s debounce me hua workspace change | snapshot disk se naya envelope uthata hai |
| K11 | Process SIGTERM | shutdown se pehle force flush (IDs + paisa) |
| K12 | Naya ID add/import (mini-app) | turant force backup, deploy ka intezaar nahi |
| K13 | ID ka session Swiggy par khatam | "Sessions check karein" par asli jawab + `sessionExpired` mark |
| K14 | Vault key badal gayi | `workspaceHealth.failed` + saaf line "key se khul nahi rahe, data safe hai" |
| K15 | Non-boss identities maange | 403 |
| K16 | Cookies UI me | kabhi nahi — sirf masked number (`98••••3210`) |

---

## L. UTR se payment details khud fetch (Round 23)

**Boss ka order:** "BAS USER KO BOL SEND HOW MUCH MONEY YOU WANT — THAT WILL BE FETCHED AND
ADDED UPON SUBMITTING UTR."

Yani flow badal gaya: pehle QR → intent → phir UTR. Ab user **jitna bhejna hai utna likhta hai**
+ UTR daalta hai. Server us UTR ki asli payment **khud fetch** karta hai (`utr-lookup.js`) aur
**jitna paisa sach me aaya utna hi** wallet me jodta hai.

**Env (Render):** `UPI_UTR_LOOKUP_URL` (ya purana `UPI_UTR_VERIFY_URL`), optional
`UPI_UTR_VERIFY_TOKEN` (bearer). Set na ho to claim fail nahi hota — `lookupLine` me saaf
likha aata hai ki fetch nahi ho paya aur claim PENDING rehta hai (jhootha credit kabhi nahi).

`fetchUtrPaymentDetails(utr)` → `{ configured, found, payment: { utr, amountPaise, payeeName,
payeeVpa, payerName, status, at, ref, source }, reason, tried: ['POST','GET'] }`.
POST JSON pehle; 404/405/501 par GET; 8s timeout.

| # | Case | Behaviour |
|---|---|---|
| L1 | QR khula hai + UTR | wahi intent use hota hai (`topupId`) |
| L2 | Koi QR nahi khula | **implicit intent** ₹1–₹500, user ke likhe amount se (`implicit: true`) |
| L3 | Purana/stale `topupId` | 409 `NO_TOPUP_INTENT` — chupchaap naya intent nahi |
| L4 | User ₹20 likhta hai, provider ₹12.50 deta hai | **sirf ₹12.50** judta hai, response `creditedPaise: 1250` |
| L5 | Provider ne amount nahi diya | `found: false`, wajah "provider ne amount nahi diya", claim PENDING |
| L6 | Provider URL set hi nahi | `lookupLine` me env ka naam, claim PENDING, credit 0 |
| L7 | Provider "pending"/"processing" | credit nahi — PENDING |
| L8 | Provider UTR match nahi karta | `UTR_MISMATCH` — dusre ka paisa kabhi nahi |
| L9 | Payee Misbahul Islam nahi | `PAYEE_MISMATCH` (round 20 ka niyam bacha hua) |
| L10 | Wahi UTR dobara | 409 duplicate — ek UTR ek hi baar |
| L11 | Claim PENDING reh gaya, baad me paisa aa gaya | background `retryPendingUtrs({limit:5})` (db save ke saath) phir se fetch + credit |
| L12 | Amount ₹500 se zyada | 400 — ek baar me ₹500 tak |
| L13 | Amount 0 / text / missing | 400, saaf Hinglish wajah |
| L14 | User ka likha amount credit par asar | **koi asar nahi** — credit `submitTopupRequest` ke fetched amount se |

**Kahan:** `utr-lookup.js` (fetch + tolerant parse), `user-wallet.js` `claimWalletTopup` +
`submitTopupRequest` (credit = fetched amount), `upi-statement.js` `retryPendingUtrs`,
`swiggy-pro-api.js` claim endpoint, `swiggy-pro-app.js` `renderWalletCard()` (amount + UTR form,
button hamesha chalu, line: "jitna paisa sach me aaya utna hi judega").

**Test:** `test_v112_utr_fetch_and_credit.mjs` — **12/12**.

---

## M. Data erase ka aakhri rasta band (Round 24)

**Boss:** "BHAI TU PEHLE YE FIX KAR DE TAAKI KOI DATA ERASE NA HO."

Round 19/22 ne data **wapas laane** ka rasta bana diya (cloud vault + local copy + db mirror).
Bacha hua khatra **ulta** tha — aur wahi sabse mehnga:

```
boot par restore fail (key badli / network / token expire)
   → app khaali db ke saath chalta hai
   → agla backup us KHAALI snapshot ko cloud par push kar deta hai
   → purana asli data hamesha ke liye overwrite
```

Ab har push se pehle cloud ka sach padha jata hai (`vault-safety.js` ka faisla):

| Case | Pehle | Ab |
|---|---|---|
| M1 | Cloud file hai par key se khul nahi rahi | chupchaap khaali snapshot push → **data gaya** | **push BAND**, cloud waisa hi, status me "backup RUKA" + asli wajah |
| M2 | Local me kuch nahi bacha | khaali snapshot push | **push BAND** (`LOCAL_EMPTY`) |
| M3 | Cloud par zyada data, local me kam | cloud wala kam ho jata | pehle **milaya**, phir push — kabhi kam nahi |
| M4 | Verified-expired ID | backup merge usko purani cloud copy se zinda kar deta | backup-merge me `reviveDead:false` — local sach jeetta hai (boot restore me zinda session aaj bhi wapas aati hai) |
| M5 | Paisa: local wallet khaali | cloud ka balance mit jata | cloud se balance/UTR mila kar push |
| M6 | Boot restore fail | sirf console warn, panel "sab theek" jaisa | `restored:false` + asli wajah + `alerts[0]` + `safetyLine` |
| M7 | Mini-app workspace khaali (deploy ke baad) | purana bhara workspace cloud/mirror par overwrite | `guardWorkspacePush` — **push BAND**, wajah `LOCAL_WORKSPACE_EMPTY` |
| M8 | Khaali workspace db-mirror par | mirror row khaali ho jati | `writeProWorkspaceMirror` khaali envelope se bhara hua row nahi mitata |
| M9 | Boss panel | sirf "Cloud ON/OFF" | `safetyLine` + `pushBlocked` + blocked reason dikhta hai (identities + backup card) |
| M10 | Purana data chahiye | — | `bot-vault` branch ki git history me har version pada rehta hai (koi force-push nahi) |

**Kahan:** `vault-safety.js` (naya, pure faisla), `db-durability.js` (pull → merge → assess → push,
alerts, `safetyLine`), `identity-snapshot.js` (`reviveDead` option), `swiggy-pro-store.js`
(`guardWorkspacePush`, mirror guard), `swiggy-pro-app.js` (boss card warnings).

**Boss ko karna:** Render env me `GITHUB_VAULT_TOKEN` + `VAULT_ENCRYPTION_KEY` — aur **key kabhi na
badalna**, warna backup khud ruk jayega (data mitega nahi, par naya backup nahi jayega).

**Test:** `test_v113_no_data_erase.mjs` — **17/17**.

---

## N. Sirf UTR se poori payment detail (Round 25)

**Boss:** "UPI payment agar me track karna chahta ... bas usse UTR lunga aur UTR se sab details
nikaalunga — isne pay kia abhi ya old, ya kisi aur ko, aur kitna."

User se sirf **UTR** liya jata hai. Us UTR par server khud ye sab nikaalta hai (`utr-truth.js`):

| Cheez | Kaise nikalti hai |
|---|---|
| **Kitna** | provider/statement ka asli amount (`amountPaise`), ₹ text me — user ka likha amount alag column me |
| **Kab (abhi ya old)** | payment ka asli timestamp → `JUST_NOW` (<5 min) / `RECENT` / `TODAY` / `DAYS` / `OLD` (>7 din) / `UNKNOWN` + "2 min pehle", "30 din pehle" |
| **Kisko** | payee naam + VPA ko boss ke naam/VPA (`mius@ybl`) se match — "paisa humein aaya" ya "kisi AUR ko gaya (naam/VPA)" |
| **Kaun bheja** | payer ka naam/VPA (provider de to), warna `missing` me "payer chahiye" |
| **Status** | SUCCESS / PENDING / FAILED / reversal — asli shabd ke saath |
| **Pehle use hua?** | global UTR ledger se — kis user ke hisaab me, kab |
| **Faisla** | wahi round-20 policy (`evaluateUtrCredit`): CREDIT / PENDING / REJECT + kyun |
| **Kya kya chahiye** | jo field provider ne nahi di (time/payer/payee/amount/provider URL) — saaf list |

Kahan dikhta hai:
* **Claim response** — `utrTruth` (amount, asked, when, payee, payer, status, verdict, checklist rows).
* **Boss panel → "UTR se payment track"** — koi bhi UTR daalo, poora sach + faisla + kya chahiye.
* **`POST /pro/api/boss/utr`** (sirf boss) — `{utr}` ya `?utr=`; `{truth, bossLine, ledger, claim,
  history, lastTrackedAt}`.
* Har lookup `config.utrLookups` me yaad rehta hai (500 tak) — baad me bhi poochha ja sake.

**Test:** `test_v114_utr_truth.mjs` — **17/17**.

---

## O. "Deploy hote hi sab erase" — ab har kadam live check (Round 26)

**Boss:** "PHIR DEPLOY HOTE HI SAB ERASE HOGAYA."

Backup ka poora system tha par **chal raha tha ya nahi, kisi ko pata nahi chalta tha**. Ab
`durability-doctor.js` ek ek kadam **sach me** check karta hai:

| # | Check | Fail hone par kya dikhta hai |
|---|---|---|
| O1 | Server disk likha ja sakta hai? | path + asli error |
| O2 | `PRO_VAULT_CLOUD_BACKUP` chalu? | "cloud backup band hai" |
| O3 | `GITHUB_VAULT_TOKEN` set? | fingerprint (8 char) — poora token kabhi nahi |
| O4 | `VAULT_ENCRYPTION_KEY` set? | "set nahi — vault plaintext/khula nahi hoga" |
| O5 | GitHub repo access (token chalta hai?) | HTTP status + message |
| O6 | `bot-vault` branch bani? | 404 = pehla backup nahi hua |
| O7 | Login-ID snapshot | kitni ID / workspace, ya "khul nahi raha (key?)" |
| O8 | Paisa + UTR snapshot | kitne wallet / UTR / balance |
| O9 | **Write test** — chhota heartbeat vault me push + wapas padho | token read-only ho to yahin pakda jata hai |

Saath me:
* **`restoreFromVaultNow()`** — boss ke ek button se poora vault turant wapas (bina naya deploy).
* **`POST /pro/api/boss/durability`** — doctor ka poora jawab.
* **`POST /pro/api/boss/durability/restore`** — force restore + turant naya backup.
* Panel card: **"Backup ka asli check"** (✅/❌ rows + "Karna hai:" line + restore button).
* Boot par doctor chalta hai; restore possible na ho to log me saaf warning.

**Asli bug jo isi jaanch me mila:** GitHub contents API **1 MB se badi file ka content khaali**
(`encoding: "none"`) deta hai. Purana code use "file nahi mili" maan leta tha → restore fail →
backup guard ko remote khaali lagta → data overwrite. Ab bade file ke liye `git/blob` se poora
content aata hai (`via: 'blob'`).

**Test:** `test_v115_durability_doctor.mjs` — **13/13**.

---

## P. Look & feel — premium par jhooth nahi (Round 27)

**Boss:** "SEE ALL THESE ANIMATION AND FONT AND STRATEGY ITS LOOKS AMAZING."

Jo cheez **precision** hai (font, motion, feedback) wo add ki — jo cheez **jhooth** hoti
(incognito, fake delete ka waada) wo nahi ki.

| # | Cheez | Kya hua |
|---|---|---|
| P1 | Font | **Manrope** (Google Fonts, `display=swap`, preconnect) + Inter/system fallback — pehle render block nahi |
| P2 | Numbers | bill/money par `tabular-nums` — digits hilte nahi, bill padhna aasan |
| P3 | Motion tokens | `--ease-soft`, `--ease-spring`, `--dur-1/2/3` — sab animation ek hi bhasha me |
| P4 | Card entrance | `card-in` + chhota stagger (0–118ms) — list "aa rahi hai" lagti hai |
| P5 | Buttons | press par `scale(.965)`, hover lift, focus ring — har button same feel |
| P6 | Bottom nav | active tab ka pill + icon bump |
| P7 | Toast | upar se drop, icon ke saath: **hara ✓ = kaam hua**, **laal ! = nahi hua**, **i = neutral** (type guess nahi hota) |
| P8 | Skeleton | shimmer lines + pill; bill/coupon aate waqt "Finding the best coupon" card (khaali jagah nahi) |
| P9 | Sheet | spring rise + backdrop blur + grip pulse |
| P10 | Coupon page | "AVAILABLE COUPONS n" header (screenshot jaisa) |
| P11 | Reduced motion | `prefers-reduced-motion: reduce` par saari animation band |
| P12 | Preview | `npm run preview:miniapp` — asli app, demo data (bina Telegram) |

**Nahi kiya (jaan-boojh kar):** competitor ka "Incognito — order history deletes in 3 hours"
jaisa toggle. Wo Swiggy ke andar ka feature hai; hum use sach me nahi kar sakte, isliye
dikhawa nahi banaya. Jab asli rasta mile tab jayega.

**Test:** `test_v116_premium_look.mjs` — **9/9**.

## Q. Spacing / font size / animated icon — reference level (Round 28)

**Boss ka sawaal:** *"pura spacing, font size, animated icon, sab copy nahi hoga to bolo ki
nahi kar sakta."* — Isliye yahan saaf-saaf likha hai: kya kar diya, aur kya nahi ho sakta.

| Cheez | Hukum | Ab kya hai |
|---|---|---|
| Spacing rhythm | 4px grid (`--s-1…--s-7`), card 16px padding | ✅ har screen par lagu |
| Font scale | `--t-11…--t-27`, numbers `tabular-nums` | ✅ har heading/row/bill par |
| Card look | radius 18, `--shadow-card`, hover lift | ✅ |
| Animated icons | draw / pop / spin / blink / nudge / check-pop | ✅ SVG stroke animation, reduced-motion me band |
| Toggle | asli `role="switch"` + `aria-checked` | ✅ group cart |
| Payment tiles | UPI green tick, Card/COD faded, "Updating" spinner | ✅ |
| Pay bar | `PAY USING UPI` + amount + `PAY NOW` | ✅ |
| Coupon sheet | head + close + count + applied ribbon + APPLY | ✅ |
| Delivered screen | bada green check + Back to Orders | ✅ sirf real `delivered` status par |

**Nahi kiya (aur kyun):**
* Coupon code input — round-9/49 ka niyam: sirf list + APPLY, taaki "coupon nahi laga" ka jhooth na ho.
* "Incognito / history 3 ghante me delete" — Swiggy ke andar ka feature, hum chalate nahi. Nakli
  toggle = customer se jhooth. **Ye nahi kar sakta.**
* Card/COD ko enable dikhana — hum sirf UPI lete hain; chalu dikha kar paisa atkana galat hoga.

**Guards:** `test_v117_reference_visual_system.mjs` 9 checks; sweep **85/85**, `npm test`
**132/132**, `test:pro` **41/41**.

## R. Ek page, saari information — bolne wala app nahi (Round 29)

**Boss:** *"uska bot ek page me saari information de raha hai, tera wala batate batate dam
tod de raha hai."*

| Pehle | Ab |
|---|---|
| Cart page: 1,939 visible chars | **1,305** chars |
| Bill ka poora plain-text copy dobara screen par | `hidden`, `Poora hisaab` par khulta hai |
| Coupons ke liye alag page | 3 coupon + **APPLY** usi page par, `Saare coupons (n)` ek tap door |
| Har card ke neeche samjhane wala paragraph | hati hui — sirf wahi line jo kaam ki hai |
| 2-minute rule page ke beech paragraph | pay bar me chhoti chip (text wahi) |
| ETA strip me duplicate address | hata diya |

**Nahi hataya (kyunki ye jhooth se bachate hain):** UTR ka "jitna sach me aaya utna hi
judega", fee ka sach, paisa kis UPI par jata hai, delivery OTP, operator-ID restriction.
Chhota likha, hataya nahi.

**Guards:** `test_v118_one_page_no_lecture.mjs` 5 checks; sweep **86/86**, `npm test`
**132/132**, `test:pro` **41/41**.

## S. Screenshot QA — jo code padh kar nahi dikhta (Round 30)

Asli Chromium (390×844 @2x) me 10 screens capture kiye (`npm run shots:miniapp`) aur render
dekha. Chaar bug mile jo sirf render me dikhte hain:

| Bug | Screen par kya dikh raha tha | Fix |
|---|---|---|
| Emoji tofu | savings banner me khaali box | apna SVG `spark` icon |
| Khaali "₹" buttons | wallet presets ka amount gayab | number **aur** object dono shape |
| Generic address | `DELIVERING TO` ke neeche "Delivery address" | asli naam (`Skk`) |
| Sheet side me | coupon sheet aadhi screen ke bahar, nav block | `translateX(-50%)` hataya |
| Blur hang | orders/tools screenshot timeout | backdrop blur hataya |

Naya: coupon **bottom sheet** (dimmed backdrop, grip, close), orders ka `This Account /
Last 1 Hour` filter (count sirf jab time parse ho), order detail ka bill section (sirf
jo Swiggy deta hai + `Total paid`).

**Guards:** `test_v119_visual_qa_fixes.mjs` 8 checks; sweep **87/87**, `npm test` **132/132**,
`test:pro` **41/41**. Inventory: `docs/REFERENCE_INVENTORY.md`.

## T. Accounts screen — reference jaisa, copy JSON asli (Round 31)

| Cheez | Reference | Ab |
|---|---|---|
| Topbar | 60px, PRO badge, icon chip | ✅ wahi naap |
| Add Account card | Number/JSON pill, flag + +91, gradient Send OTP | ✅ CSS tiranga, icon CTA |
| Saved Accounts | heading + count + hairline | ✅ |
| Search | "Search Account..." | ✅ naam **ya** number se instant filter |
| Row | Used pill, JSON copy, green check, delete | ✅ |
| Copy JSON | JSON clipboard me | ✅ **asli session** server se (apne account ka) |

**Sach (jhooth nahi):** shared/operator vault ID ka session non-boss ko **403** — token
response me aata hi nahi. Copy fail ho to laal toast, chup-chaap success nahi.

**Guards:** `test_v120_accounts_reference_and_copy_json.mjs` 12 checks; sweep **88/88**,
`npm test` **132/132**, `test:pro` **41/41**.

## U. QR ke baad poore 5 minute verify, phir My Orders + Swiggy ka share link (Round 32)

**Boss (31-10-2026):** "QR aane par 5 minute tak payment verify chalta rahe; verify hote hi
My Orders par jaye, order khole, aur Share link de."

| Cheez | Kaise | Proof |
|---|---|---|
| Verify window | `PAY_WINDOW_MS = 5*60*1000`, `PAY_POLL_MS = 5000` — pehla check 5s par, phir har 5s, poore 5:00 | `test_v121` (7 checks) |
| Countdown | `[data-pay-clock]` par `m:ss` — sirf `textContent` badalta hai, re-render nahi, isliye QR flash nahi karta | v121 + screenshot `screenshots/14-qr-verify-5min.png` |
| Kitni baar check hua | strip par `N×` (`state.payTicks`) — chhupa hua kaam nahi | v121 |
| 5 minute poore | strip `.expired`: "5 minute poore ho gaye" + Payment check button. Spinner nahi — sach | v121 |
| Verify hote hi | `openOrdersForOrder(id, { share: true })` → My Orders tab + wahi order khulta hai + `loadOrderTracking` | v121 |
| Share link | `.share-card` — readonly input me Swiggy ka asli link + "Copy link" + "Telegram par share" (`t.me/share/url`) | v121, `screenshots/15-share-link.png` |
| Link na mile | "Swiggy ne is order ka share link nahi diya… Hum apna link nahi banate" + Refresh. Jhoothi link kabhi nahi | v121 |

**Kya nahi kiya (sach):** Swiggy app ke andar ke "three dot → Share" par hum khud tap nahi
karte (wo unki app hai, hamare control me nahi). Wahi link Swiggy ke `trackV4 cta_link` se
aata hai — wahi yahan dikhta hai. Polling 5 minute ke baad band ho jati hai (battery/rate limit).

## V. Payment page saaf + bill tez/sahi + account filters (Round 33)

**Boss (01-11-2026):** "PAYMENT PAGE SE OPEN UPI APP HATAYE AND CANCEL ORDER AND I HAVE PAID
KA OPTION DE BAS FALTU KE ORDER TRACK KARE ... BHAI BILL SAHI SE CALCULATE KARLE PLEASE ...
SAVED ACCOUNT KE NICHE EK FILTER DEDO USED FRESH NIGHT BREKFAST ... MULTIPLE FILTER"

| Cheez | Kaise | Proof |
|---|---|---|
| Payment page | Sirf: kitna dena hai, QR, **I have paid**, **Cancel order**. `Open UPI app` (upi:// link), track button, "original account ke orders" — sab hata diye | `test_v122` #1, `test_v104` #10, screenshot `screenshots/16-payment-two-buttons.png` |
| Cancel order | Confirm → `POST /pro/api/checkout/cancel` → checkout band, wallet fee wapas (unpaid), cart wapas. Sach likha jata hai: Swiggy ka bana hua unpaid order hum cancel nahi kar sakte | `test_v122` #2 |
| I have paid | `checkout/status` → PAID → seedha My Orders → wahi order → share link + **Copy** + **Go back** | `test_v122` #3, screenshots/18 |
| Go back | `back-to-cart` → wahi normal cart page | `test_v122` #3 |
| Bill tez | Do kadam: pehla bill **fast** (address + cart write + readback, ~4 calls), phir `cart/optimize` par offers + One Lite + coupon trials. Bill card par "Best coupon check…" chip | `test_v122` #7 |
| Bill sahi | (a) "available" Swiggy Money ab discount nahi — sirf jo SACH ME kata (`swiggy_money`); (b) campaign free cash ek hi line (trade discount ke andar ho to double nahi); (c) residual GST me pehle se kata wallet wapas joda | `test_v122` #8/#9, `test_v103` 6/6 |
| Account filters | Saved Accounts ke neeche `USED · FRESH · NIGHT · BREAKFAST` + counts, multi-select, Clear. Sirf sach: FRESH/USED live check se, NIGHT/BREAKFAST offer record se (jahan check nahi hua, dono nahi) | `test_v122` #5/#6, `screenshots/17-account-filters.png` |

**Kya nahi kiya (sach):** Swiggy ke bane hue unpaid order ko hum cancel nahi kar sakte — wahi app
me saaf likha jata hai (jhootha "cancel ho gaya" nahi).

## VI. Round 34 — "checkout faster + Pay Now ke bagal kuch + dash hatao"

Boss: *"MAKE THE CHECK OUT FASTER AND BESIDE PAY NOW BUTTON ADD SOMETHING AND REMOVE THAT DASH
WHICH ANIMATION — NOT THE ROUND BUT LITTLE CREATIVE WHICH DENOTES BILLS ARE LOADING … IT SHOULD
BE AFTER BILL IS FETCHED YOU HAVE 2 MINUTES TO CLICK PAY NOW OTHERWISE EVERYTHING WILL GET CLEAR."*

| Cheez | Kaise | Proof |
|---|---|---|
| 2 minute ka clock **bill aane ke baad** | `planIdleExpiry` ab `cart.quote.fetchedAt` ko hi aakhri activity maanta hai; bill aane se pehle (DRAFT + cart, bill nahi) kuch saaf nahi hota. Bahut purana adhoora draft 15 min par phir bhi saaf (`STALE_DRAFT_TIMEOUT_MS`) | `test_v123` #1–#5, `test_v102` 14/14 |
| Pay Now ke bagal kuch | `Pay Now` ke bagal (`.pay-left`) **live clock**: `● 1:59` (30 second bache to laal, khatam to "Time up"). Bill ke bina `—` — koi andaaza nahi | `test_v123` #9, `screenshots/19-paybar-pay-countdown.png` |
| Dash animation hataayi | Upar ki patli sweeping load bar (`#loadbar`, `@keyframes loadbar-run`) HTML + CSS + JS se poori tarah gayi | `test_v123` #6 |
| Bill load hone ka creative indicator | Bill ke liye chhoti **"receipt print"** card: bill ki lines ek-ek karke print hoti hain (bill-paper), na spinner na dash. Retry link bhi hai — dead end nahi | `test_v123` #7/#8/#10, `screenshots/20-bill-loading-closeup.png` |
| Checkout tez | (a) address confirm 10 min cache (`cart.confirmedAddress` + fingerprint) — 2 Swiggy call kam; (b) cart write ke apne jawab me poora cart ho to alag readback GET nahi — 1 call kam; (c) fast phase timeout 7s (min 4s) — bill latakta nahi. Har jhooth-blocking validation waisa hi rehta hai | `test_v123` #11/#12 |

**Kya nahi kiya (sach):** Swiggy ka cart write/readback **hum skip nahi kar sakte** — bill sirf
Swiggy ke jawab se banta hai. Cache sirf tab lagta hai jab naam + phone + street + PIN bilkul
wahi ho (fingerprint). Isse zyada tez karna = Swiggy se jhooth bolna.

## VII. Round 35 — cancel saaf, bill consistent, free cash pehle bill me

Boss: *"ORDER CANCEL HOJANA CHAHIYE BUT CHECKOUT NEEDS CHECKING KA CARD ARAHA … CHECK THIS ORDER
AND CHECK ORIGINAL ACCOUNT … ISKO HATADO … FREE CASH ABHI BHI NAHI LAG RAHA … JO BILL DIKHA RAHA
PAY NOW PAR CLICK KARTA HU TO WO CHANGE HOJATA … CONSISTENT NAHI HAI."*

| Cheez | Kaise | Proof |
|---|---|---|
| Cancel = cancel | `/checkout/cancel` checkout band karta hai, wallet fee wapas, cart wapas — order dobara ho sakta hai. `PAID` par 409 (jhoothi cancellation nahi) | `test_v124` #1–#3 |
| "Needs checking" card gaya | Ab `.cancel-card` — sirf **Order cancel karein** + ek chhoti line. `checkout-orders` aur `checkout-status` buttons nahi | `test_v124` #6/#7, `test_v90` #5, `screenshots/21-cancel-card.png` |
| Locked line | "pehle original account check karein" hata — "neeche diye button se cancel karein" | `test_v90` #4 |
| Bill consistent | Do kadam (fast → optimize) hata diye. Ab ek hi poora bill (`phase: 'full'`); jo Pay bar par dikha wahi `expectedTotal` ban kar checkout jata hai | `test_v124` #4, `test_v122` #7 (naya contract) |
| Free cash / night cash | Offer claim ka jawab cart push se **pehle** liya jata hai (12s tak) — isliye free cash usi pehle bill me aata hai, agle me nahi | `test_v124` #5 |
| Claim ka sach | Bill card par chhoti line: `1 offer claim hua` / `Swiggy ke hisaab se ye ID pehle le chuki hai (PRE_LOCKED)` / claim fail ki asli wajah | `test_v124` #8, `screenshots/22-bill-offer-note.png` |

**Kya nahi kiya (sach):** Swiggy par bana hua order hum cancel nahi kar sakte — cancel sirf humara
checkout band karta hai, aur wahi app me saaf likha jata hai. Free cash tabhi lagta hai jab Swiggy
us campaign par discount deta hai; `PRE_LOCKED` par koi jugaad nahi, bas sach dikhta hai.
