# Feature Checklist — kya bana hai, kya main bana sakta hoon

**Date:** 2026-11-01 · **Branch:** `arena/e07b3a2c-ammi-abbu-ka-sacha-beta` · **Main:** `07fbb0a` (PR #110)

Ye file sach bolti hai. Teen hi tarah ke nishaan hain:

| Nishaan | Matlab |
|---|---|
| ✅ | **Bana hua hai aur test se prove hai.** Koi jhooth nahi, koi adhoora kaam nahi. |
| 🟡 | **Aadha bana hai.** Kaam karta hai par ek hissa missing hai — neeche likha hai kya. |
| ⬜ | **Nahi bana. Main bana sakta hoon** — effort likha hai: **S** = 1 turn, **M** = 2–3 turn, **L** = 4+ turn. |
| ⛔ | **Main nahi bana sakta / nahi banaunga** — asli wajah saath likhi hai. Jhooth feature se achha "nahi" hai. |

Aaj ki ginti: **38 API route · 54 in-app action · 6 tab · 125 test file · 89 guard suite · 132 + 41 checks — sab pass.**
Server aaj chala kar dekha: `/healthz` 200, `/pro` 200.

---

## 1. Mini app — Customer ka screen (6 tab)

### 1.1 Accounts tab (ID)
| # | Feature | Status | Note |
|---|---|---|---|
| 1 | ID list — naam, masked phone, live/expired badge | ✅ | `renderAccounts()` |
| 2 | Ek tap se ID switch (instant) | ✅ | refresh par doosri ID par land karta hai |
| 3 | Used ID par warning + confirm ke baad hi select | ✅ | `ACCOUNT_NEEDS_CONFIRM` |
| 4 | ID search filter | ✅ | `input[data-input="account-search"]` |
| 5 | Session JSON copy (1 tap, clipboard → toast) | ✅ | `GET /pro/api/accounts/session` — apni 200, doosre operator ki 403 |
| 6 | OTP se naya ID add (send-otp → verify-otp) | ✅ | rate limit 8/hour |
| 7 | Session `.json` paste/import se ID add | ✅ | `accounts/import` |
| 8 | Delete ke **2 option** (DB se / Swiggy se + delete OTP) | ✅ | standing rule |
| 9 | "1 ID = 1 live order" lock (doosre order par doosri ID) | ✅ | `order-account-lock.js` |
| 10 | Per-ID offer track badge | ✅ | `OFFER_TRACKS` se, hardcoded count nahi |
| 11 | Per-ID session expiry countdown ("3 din baaki") | ⬜ **S** | `savedAt` + Swiggy session life se — jhooth nahi, jitna pata hai wahi |
| 12 | "Ye ID kis order me locked hai" ka saaf badge | ⬜ **S** | data already hai, sirf UI |
| 13 | Ek ID ka poora hisaab (kitne order, kitna paisa) — ID card par | ⬜ **M** | statement se jodna padega |
| 14 | Bulk ID import — ek saath 6+ file | 🟡 | bot side chalta hai; mini app me ek-ek file. **M** |

### 1.2 Address tab
| # | Feature | Status | Note |
|---|---|---|---|
| 15 | Address list + select | ✅ | `addresses/select` |
| 16 | Link se address (onelink / maps) resolve | ✅ | `addresses/resolve` |
| 17 | Confirm ke baad hi use, warna "abhi confirm nahi" | ✅ | `addresses/confirm` |
| 18 | Receiver ka naam + mobile edit | ✅ | `addresses/update-contact` |
| 19 | Type kiya hua address kabhi drop nahi hota | ✅ | guard `test_v79` |
| 20 | Favourite address pin (ghar = default) | ⬜ **S** | chhota UI + ek flag |
| 21 | "Yahan tak delivery hoti hai?" pin check | ⛔ | Swiggy ka serviceability call hamare paas live nahi; bina jaache "haan" bolna jhooth |

### 1.3 Search tab
| # | Feature | Status | Note |
|---|---|---|---|
| 22 | Restaurant search | ✅ | `search` route |
| 23 | Outlets sheet — distance + rating | ✅ | `restaurants/outlets` |
| 24 | Menu + dish add + qty | ✅ | `menu`, `cart/add`, `cart/quantity` |
| 25 | Purane searches / recent restaurants | ⬜ **S** | local cache, koi tracking nahi |
| 26 | Veg-only filter | ⬜ **S** | `isVeg` data already aata hai |
| 27 | Sort: rating / delivery time / distance | ⬜ **M** | outlets data me teeno hai |
| 28 | Dish ka variant / addon chunna (Half/Full, extra cheese) | ⬜ **L** | abhi `variants: []` jaata hai — asli customisation picker banna hai (Swiggy ke add-item API se) |

### 1.4 Cart + Bill + Payment (sabse bada hissa)
| # | Feature | Status | Note |
|---|---|---|---|
| 29 | Group cart import (Swiggy ka shared cart) | ✅ | `cart/import-group` + toggle + round import button |
| 30 | Cart Swiggy jaisa — savings banner, Savings Corner, meal rail | ✅ | round 30 parity |
| 31 | Bill = Swiggy ke apne lines (Item total, coupon, packing, GST, delivery) | ✅ | `bill-reconcile.js` |
| 32 | "Poora hisaab" ek tap me (hidden `<pre>` bill) | ✅ | round 29 — ek page density |
| 33 | Free delivery + ₹50 off ₹199 (Option 1) | ✅ | standing rule |
| 34 | Coupon sheet — APPLY only, **koi code input nahi** | ✅ | rule #49 |
| 35 | Coupon remove / best-coupon proof line | ✅ | `couponTrials` se asli line |
| 36 | Bill refresh (naya bill Swiggy se) | ✅ | `bill-refresh` + confirm |
| 37 | Wallet card + top-up sheet + UPI `mius@ybl` | ✅ | rule: fee order ke baad hi dikhta hai |
| 38 | ₹15 wallet gate (kam balance par order nahi) | ✅ | `WALLET_LOW_BALANCE` saaf message |
| 39 | Pay bar "PAY USING UPI ₹xxx → PAY NOW" | ✅ | round 28 |
| 40 | 2-minute idle chip + auto close | ✅ | rule #49 — chip visible rehti hai |
| 41 | QR recovery (QR na aaye to dobara maango) | ✅ | `test_v101` |
| 42 | UTR se auto verify — **payee/VPA match zaroori** | ✅ | random/small UTR credit nahi hota |
| 43 | **QR ke baad poore 5 minute verify** (har 5s, live countdown) | ✅ | round 32 — `[data-pay-clock]` |
| 44 | 5 minute poore → saaf "poore ho gaye" + Payment check | ✅ | spinner me nahi chhupta |
| 45 | Verify hote hi → My Orders + wahi order khulta hai | ✅ | round 32 |
| 46 | Fullscreen / bada QR (scan karna aasan) | ⬜ **S** | abhi card me QR; ek tap par poori screen |
| 47 | QR ke saath UPI ID 1-tap copy | ⬜ **S** | QR na scan ho to haath se pay |
| 48 | "Screen ki brightness badha dein" hint | ⬜ **S** | sirf text, kaam nahi |
| 49 | Order again — purane order ke items cart me daal do | ⬜ **M** | orders se seedha re-order, bada time bachta hai |
| 50 | Payment ke baad poora receipt (order ID + UTR + amount) ek card | 🟡 | bill + tracking hai; ek "receipt card" missing — **S** |

### 1.5 Orders tab
| # | Feature | Status | Note |
|---|---|---|---|
| 51 | Live orders list | ✅ | `orders` |
| 52 | Filter: This Account / Last 1 Hour | ✅ | `orders-filter` |
| 53 | Order detail + bill | ✅ | round 30 |
| 54 | Tracking khud aata hai (Refresh dabana zaroori nahi) | ✅ | round 21 |
| 55 | Tracking timeline + ETA + delivery OTP + partner | ✅ | `tracking-truth.js` |
| 56 | **Share link — Swiggy ka asli link, copy + Telegram share** | ✅ | round 32, apna link kabhi nahi |
| 57 | Link na mile to saaf sach + retry | ✅ | "Hum apna link nahi banate" |
| 58 | SMS ka sach (bheja/nahi/bina proof) | ✅ | jhootha "sent" nahi |
| 59 | Delivered hero + Back to Orders | ✅ | round 28 |
| 60 | Order cancel request (confirm ke baad, bot ke through) | ⬜ **M** | bot me cancel hai, app me button nahi |
| 61 | ETA card Telegram par share ("20 min me aa raha hai") | ⬜ **S** | share infra ab bana hua hai |
| 62 | Delivery OTP bade font me, poori screen | ⬜ **S** | budhe parents ke liye |

### 1.6 Tools tab
| # | Feature | Status | Note |
|---|---|---|---|
| 63 | Offer claim — breakfast / night / weekend / welcome | ✅ | Swiggy jo kehta hai wahi dikhta hai |
| 64 | Offers sirf ek baar claim (repeat proof nahi) | ✅ | standing rule |
| 65 | Cloud backup now | ✅ | `backup` + mirror |
| 66 | Identities list + verify + backup | ✅ | `boss/identities` |
| 67 | Durability doctor — run + restore | ✅ | `boss/durability` |
| 68 | Statement (UTR truth, pending claims) | ✅ | `boss/statement` |
| 69 | Dark mode | ✅ | theme + yaad rehta hai |
| 70 | Statement export (CSV / JSON download) | ⬜ **S** | Blob + download, koi server kaam nahi |
| 71 | Mahine ka kharcha — "is mahine ₹X, N order" | ⬜ **M** | statement se jodna |
| 72 | Bada text mode (elderly parent ke liye 1 tap) | ⬜ **S** | CSS root font scale + localStorage |
| 73 | Notification toggle — kis cheez par DM aaye | ⬜ **M** | bot DM bhejta hai; app me switch |

---

## 2. Look & feel (round 27–32 ka kaam)

| # | Feature | Status |
|---|---|---|
| 74 | Manrope font, type scale `--t-11…--t-27`, 4px spacing grid | ✅ |
| 75 | Soft cards, 18px radius, shadow tokens | ✅ |
| 76 | Animated icons (6), payment tiles, pay bar | ✅ |
| 77 | Top toast — green check / red × (sach ke hisaab se) | ✅ |
| 78 | Skeleton loading, "Finding the best coupon" shimmer | ✅ |
| 79 | `prefers-reduced-motion` — sab shaant | ✅ |
| 80 | ≤380px chhote phone par bhi toota nahi | ✅ |
| 81 | Mini app se **bahar navigation band** (sirf Swiggy tracking link) | ✅ |
| 82 | Accounts screen reference jaisa (font/spacing/ID display) | ✅ |
| 83 | Swiggy ka brand/logo clone **nahi** | ⛔ |
| 84 | Screenshot diff har round (Chromium 390×844 dsf2) | ✅ |
| 85 | 5 aur reference screenshot ka pixel-parity pass | ⬜ **M** — jitne screenshot doge, utne |

---

## 3. Boss (operator) side

| # | Feature | Status | Note |
|---|---|---|---|
| 86 | Boss panel (Telegram) | ✅ | `boss-panel.js` |
| 87 | `/accounts`, `/addresses`, `/cart`, `/pro` menu | ✅ | |
| 88 | `/parallel` — parallel multi-ID | ✅ | |
| 89 | `/autoqr`, `/claim`, `/waf`, `/setupi`, `/cancel` | ✅ | |
| 90 | Wallet & Fee ek panel | ✅ | rule: single panel |
| 91 | Boss statement + UTR list | ✅ | `boss/utr` |
| 92 | Boss mirror (doosre device par bhi dikhe) | ✅ | `boss-mirror.js` |
| 93 | Daily digest DM — aaj kitne order, kitna paisa | ⬜ **M** | cron + rich-text |
| 94 | Per-customer ledger (kaun kitna dega) | ⬜ **M** | data statement me hai |
| 95 | Boss ke liye mini app me "aaj ka hisaab" screen | ⬜ **M** | |

---

## 4. Sach / safety engine (jis par poora bharosa tika hai)

| # | Feature | Status | Note |
|---|---|---|---|
| 96 | UTR truth — 12 digit, payee + VPA match, warna credit nahi | ✅ | `utr-truth.js`, `upi-credit-policy.js` |
| 97 | Ek UTR dobara use nahi hota | ✅ | guard `test_v109` |
| 98 | QR guard — galat/duplicate QR block | ✅ | `payment-qr-guard.js` |
| 99 | Order → ID lock (live order wali ID doosre order ko nahi) | ✅ | `order-account-lock.js` |
| 100 | 2-minute idle order expiry | ✅ | `order-idle-expiry.js` |
| 101 | Tracking truth — guess nahi, sirf Swiggy ka jawab | ✅ | `tracking-truth.js` + `tracking-validation.js` |
| 102 | SMS truth — bot khud SMS nahi bhejta | ✅ | `sms-notify.js` sirf sach likhta hai |
| 103 | Rate limit ek jagah (11 bucket) | ✅ | `pro-rate-limit.js` |
| 104 | WAF / network shield + backoff pool | ✅ | `waf-pool.js`, `network-shield.js` |
| 105 | Bill reconcile — Swiggy total hi final | ✅ | `bill-reconcile.js` |
| 106 | Money snapshot — paisa ka record | ✅ | `money-snapshot.js` |
| 107 | Deploy par data erase nahi — vault + doctor | ✅ | round 26 fix |
| 108 | Deleted ID kabhi wapas nahi (tombstone) | ✅ | `vault-safety.js` |
| 109 | Purana backup live session ko overwrite nahi karta | ✅ | guard `test_v111` |
| 110 | Perf guard — page time out nahi | ✅ | `perf-guard.js` |

---

## 5. Testing / proof

| # | Feature | Status |
|---|---|---|
| 111 | 125 test file, `run_guards` 89 suite, `npm test` 132, `test:pro` 41 | ✅ |
| 112 | Live Chromium screenshot harness (`npm run shots:miniapp`) | ✅ |
| 113 | Preview scenes `?scene=paypending` / `?scene=share` | ✅ |
| 114 | CI par har PR ke saath guard chalana (GitHub Actions) | ⬜ **M** — abhi local chalta hai |
| 115 | Har round ka `docs/REFERENCE_INVENTORY.md` update | ✅ |

---

## 6. ⛔ Jo main nahi kar sakta (aur kyun)

| Cheez | Wajah |
|---|---|
| Swiggy app ke andar khud "three dot → Share" dabana | Wo unki app hai, hamare control me nahi. Wahi link hum `trackV4 cta_link` se nikaal kar dete hain — asli hota hai. |
| Swiggy ki taraf se SMS bhejna / SMS spoof karna | Bot apna SMS nahi bhejta (rule #50+). Jo Swiggy bhejta hai wahi sach hai. |
| Card / COD payment | Hum sirf UPI lete hain. Card details kabhi store nahi. |
| OTP / payment / delivery ka fake success | Har round ka pakka rule — jhooth nahi. |
| Apna tracking/share link banana | Round 32 ka rule: link Swiggy ka hi. |
| Swiggy ka ban/suspension bypass | Koi bot nahi kar sakta. 2–3 asli ghar ke ID + chhote order + ek ID ek order = safe. Bulk ID coupon farming me sab phasenge. |
| Swiggy ke private/partner API key | Hamare paas nahi, aur nahi honge. |
| 5 minute ke baad bhi verify chalate rehna | Design se band — battery aur rate-limit. |
| Is sandbox se **live Swiggy** behaviour check karna | Yahan network sirf GitHub/npm tak hai. Isliye har round ke end me "live verify nahi hua" likhta hoon. |
| Render par deploy/health khud check karna | Isi wajah se — Render tak network nahi. Deploy PR merge par trigger hota hai. |

---

## 7. Nahi code — 3 haath ka kaam (bhoolna nahi)

| Kaam | Time | Kaun |
|---|---|---|
| Render env: `BOT_TOKEN`, `BOSS_SECRET`, `VAULT_ENCRYPTION_KEY`, `GITHUB_VAULT_TOKEN` | 5 min, ek baar | tum |
| Telegram menu button → `/pro` URL | 2 min | tum |
| Ek asli order end-to-end (asli ID, asli paisa, chhota amount) | 20 min | tum + main |

---

## 8. Round 33 — mere pick (bolo kaunsa)

Meri raay me sabse zyada faayda in 3 me hai, aur teeno **S–M** hain:

1. **Order again (⬜ M, #49)** — purana order 1 tap me cart me. Roz ka sabse bada time bachta hai.
2. **Bada text + bada QR + OTP fullscreen (⬜ S ×3, #72/#46/#62)** — Ammi/Abbu ko sach me aasan. Ek hi turn me.
3. **Statement export + mahine ka kharcha (⬜ S+M, #70/#71)** — paisa ka poora hisaab, jhagda khatam.

Aur agar boss chahe to: **variant/addon picker (L, #28)** — ye sabse bada missing hissa hai, kyunki Half/Full aur add-ons ke bina kuch restaurant ka order swiggy jaisa nahi hota.

> Koi bhi cheez chuno — jaise `1, 2, 3` likh do. Main usi turn me banana shuru kar dunga, guard + screenshot ke saath.
