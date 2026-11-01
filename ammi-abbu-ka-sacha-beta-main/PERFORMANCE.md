# PERFORMANCE — "10 ORDER KE BAAD HAWA KYUN NIKAL JAATI THI"

Boss ka complaint: **"YouTube billions of logs dekh kar bhi hang nahi hota, mera
system 10 order aate hi saans nahi le pata."** Wajah feature nahi thi — **ek hi
Node process** tha jisme har cheez main thread par ho rahi thi. Neeche wahi 6
bimariyan aur unka ilaaj hai (sab `test_v64_perf_optimization_e2e.mjs` me
naapa/guna jaata hai).

## 1. DB har baar disk se padha jaata tha  → ab memory-cache
`getDb()` pehle **har call** par `db.json` disk se padhta tha aur har order +
account + draft + vault ka `JSON.stringify` (baseline) banata tha. Ek update me
yeh sau baar hota tha.

Ab (`store.js`):
- newest DB text **memory me** rehta hai (file signature se validate) → 400 getDb
  par sirf **0-2 disk read**
- baseline maps **lazy** — sirf `saveDb()` ke waqt
- `ensureDb()` memoised (2 syscalls per call gaye)
- write **compact JSON** (pretty-print sirf `DB_PRETTY=1`)
- Render par **coalesced async write** (ek tick ke kai saves = 1 disk write),
  SIGTERM/SIGINT/exit par `flushDbSync()`
- doosra process (bossbot) beech me likhe to `additiveMerge` — uska naya order
  kabhi nahi udta; tombstoned (logged-out) ID kabhi zinda nahi hoti

**Naapa hua:** 435 KB DB, 200 orders — pehle ek update **148 ms** blocking,
ab **~56 ms**; saves 7.2 ms → 4.2 ms (async me 2.9 ms). Render ke persistent
disk par farak aur bada (wahan har read me network latency lagti hai).

## 2. QR card render main thread par 180–240 ms CPU → ab worker thread
`generateNamedUpiQrPngBuffer` = pixel paint + PNG deflate + jsQR verify. 10 QR =
~2 second **poora bot frozen**. Ab `qr-render-pool.js` ise worker thread me
chalata hai (pool 2), fail/timeout par khud inline fallback (QR kabhi na ruke).
Verification ab sirf QR box par hoti hai (243 ms → 180 ms inline bhi).

**Naapa hua:** 4 QR parallel render ke dauraan 50 ms ka timer **50 ms** par hi
fire hua = main loop free.

## 3. Payment polling: 5 second par har order → ab backoff
10 pending QR = **120 Swiggy calls/minute**. Ab `5→8→12→18→25→30 s` backoff,
network blip par double, global cap 4 checks, aur `awaitingPayment` check —
stage/amount ready nahi to Swiggy ko tang hi nahi karte.

## 4. Updates bila limit parallel → ab bounded dispatcher
Pehle har Telegram update turant parallel (10 order = 10+ bhaari handler).
Ab: max **6** parallel (`UPDATE_CONCURRENCY`), queue 300 (`UPDATE_QUEUE_MAX`),
har update par **45 s deadline** (`UPDATE_DEADLINE_MS`), duplicate `update_id`
skip. Telegraf `handlerTimeout` 240 s → **60 s**.

## 5. Purana bhaara data kabhi prune nahi hota tha
`pruneDbForPerformance()`: band/purane (3 din+) orders se `availableCoupons`,
`liveCartSnapshot`, raw payloads hataata hai, `events/timeline` 40 par, health
events 120, audit log 300, 400 se zyada orders par sabse purane band orders
delete. Boot par + har 30 min. Paise/tracking/receipt fields **chhute nahi**.

**Naapa hua:** 214 KB → 62 KB (72% kam).

## 6. Log spam + memory guard
`logThrottled(key)` — same line window me ek hi baar (+ kitne suppress hue).
`startMemoryGuard()` — heap 75% par prune (+GC agar `--expose-gc`), 88% par Boss
ko **ek** honest warning.

## `/health` par ab pura sach
```json
"perf": {
  "rssMb": 210, "heapUsedMb": 84, "uptimeSec": 5400,
  "db": { "dbSizeKb": 118, "diskReads": 3, "parses": 812, "saves": 240,
           "merges": 12, "writes": 240, "avgGetDbMs": 0.3, "asyncWrite": true },
  "updates": { "active": 2, "peak": 6, "queued": 0, "timeouts": 0, "duplicates": 4 },
  "payment": { "activePollers": 3, "checksInFlight": 1 }
}
```

## Knobs (Render env)
| Env | Default | Kaam |
|---|---|---|
| `UPDATE_CONCURRENCY` | 6 | kitne update parallel |
| `UPDATE_QUEUE_MAX` | 300 | queue cap |
| `UPDATE_DEADLINE_MS` | 45000 | ek update ka budget |
| `PAYMENT_POLL_CONCURRENCY` | 4 | ek saath kitne payment check |
| `QR_WORKERS` | 2 | QR render workers |
| `QR_WORKER` | auto | `0` = inline (debug) |
| `DB_ASYNC_WRITE` | Render par on | coalesced writes |
| `DB_PRETTY` | 0 | readable db.json (debug) |
| `MEMORY_GUARD_MS` | 60000 | memory check interval |
| `LOG_THROTTLE_MS` | 10000 | same log ka window |

## Benchmark chalao
```
node bench_store.mjs              # naya
DB_FAST=0 node bench_store.mjs    # purana code (git origin/main se) — tulna
BENCH_ORDERS=200 node bench_store.mjs
```
