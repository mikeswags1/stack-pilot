# Post-Mortem: Wrongful Bulk-End of listed_asins

**Severity:** P0 — Silent destruction of core listing-state data
**Detected:** 2026-05-30 during the Listing Quality audit
**Status:** Bleeding stopped (deployed `f849ae9`); restore queued for 3:00am ET via cron `718dfa62`

---

## TL;DR
A sync routine in `refresh-products/route.ts:798-803` was bulk-marking listings as `ended_at = NOW()` whenever they weren't found in a paginated `GetSellerList` response. Pagination silently failed often (rate-limits, timeouts, partial responses) and the routine wrongly ended ~2,000+ live listings. **This bug has been firing since 2026-04-22 (38 days) and is the likely #1 contributor to poor sales performance** — reprice, duplicate-check, saturation refresh, and outcome tracking have all been operating on a near-empty dataset.

---

## 1. When did this bug first start occurring?

**First wrongly-ended row:** **2026-04-22** (~38 days ago).

**Timeline of damage:**
| Date | Listings ended | Notes |
|---|---|---|
| 2026-04-22 | 1 | First instance |
| 2026-04-28 | 58 | Slow trickle starts |
| 2026-05-01 | 275 | First significant burst |
| 2026-05-03 | 210 | |
| 2026-05-15 | 107 | |
| 2026-05-21 | 212 | |
| 2026-05-22 | 101 | |
| 2026-05-24 | 52 | |
| 2026-05-28 | 66 | |
| **2026-05-29** | **1,326** | **Catastrophic — 1,325 in a single hour (07:00 UTC)** |
| **2026-05-30** | **744** | **Same pattern continues** |

The May 29 spike was a single cron run that erased 1,325 listings from active state in one hour. Likely correlation: heavy listing during the day → Trading API quota near-exhausted at 07:00 UTC the next morning → pagination silently returned partial data → bulk-end fired against the entire "missing" set.

## 2. How many listings were incorrectly marked ended?

| Status | Count |
|---|---|
| Total ended rows with eBay listing IDs (in backup) | **3,254** |
| Genuinely ended (Amazon unavailable, sold, etc.) | ~830 (estimated) |
| **Wrongly ended (will be restored)** | **~2,193** (per yesterday's GetSellerList count) |
| Confirmed-active in DB before restore | 8 |

The restore queues a precise check against eBay's actual active set — only rows whose `ebay_listing_id` is currently active on eBay will be restored.

**Breakdown by `amazon_status_reason` on the 3,254 ended rows:**

| Reason | Count | Code path | Likely category |
|---|---|---|---|
| `check_failed` | 1,711 | `refresh-products/route.ts:1100` | **Bug — combined with line 803** |
| `(none)` | 591 | Line 803 raw UPDATE (no reason set) | **Bug — pure bulk-end** |
| `unavailable` | 511 | Availability sync | Mostly legitimate, some wrongly ended after |
| `unavailable_ended` | 320 | Line 878 (eBay end on Amazon unavailable) | **Legitimate** |
| `available` | 121 | Lines 963, 1084, 3265 | **Bug — bulk-end ran after available** |

The 121 "available but ended" rows are a smoking gun: another code path had explicitly marked these listings as Amazon-available, and the bulk-end then closed them anyway. These rows alone are proof the guard wasn't working.

## 3. Which systems were impacted?

49 code paths filter `listed_asins` by `ended_at IS NULL`. The ones with direct business impact:

| System | File | Effect when 99% are wrongly ended |
|---|---|---|
| **Reprice agent** | `lib/reprice-agent.ts` | Stopped maintaining live prices for ~2,000 listings → out-of-date vs market |
| **Listing outcomes / sales tracking** | `lib/listing-outcomes.ts` | Sales and refunds attributed to wrong listings or lost |
| **Performance scoring** | `lib/performance-scoring.ts` | Niche scoring run on tiny sample → wrong sourcing decisions |
| **Source intelligence** | `lib/source-intelligence.ts` | "What's selling" signal corrupted |
| **List-ready computation** | `lib/product-source-engine.ts` | "What's already listed" check missed listings → duplicate offerings |
| **Auto-listing scoring** | `lib/auto-listing/scoring.ts` | Queue scoring on incomplete data |
| **Duplicate detection** | `app/api/ebay/duplicate-listings/route.ts` | Missed duplicates → eBay rejection failures |
| **Admin stats / health dashboards** | `app/api/admin/stats/route.ts`, `health/route.ts` | Showed dramatically understated active count |
| **Repair / cleanup tools** | `app/api/admin/repair-listings/route.ts`, etc. | Couldn't target affected listings |
| **Outcome tracker** | `app/api/cron/outcome-tracker/route.ts` | Sales metrics corrupted |
| **Digest agent** | `lib/digest-agent.ts` | Daily reports underreported |

## 4. How long has this been affecting performance?

- **First wrong end-mark:** 2026-04-22 (~38 days ago)
- **Worst single event:** 2026-05-29 (1,326 listings ended in one day)
- **Cumulative damage acceleration:** Last 7 days produced ~2,600 of the 3,254 wrong ends — the bug was getting worse, not better, because API quota pressure increased with listing volume.

**This is the most likely #1 factor in poor sales performance**, because:
- The reprice agent was blind to ~2,000 active listings → stale prices vs competition
- The duplicate-detection check was blind to them → new listing attempts collided
- Performance scoring saw a tiny subset → wrong sourcing decisions
- The user had **3 sales on 2,100 listings (0.14%)** while listings were silently uncared for

## 5. What safeguards should we add?

The disabled block at `refresh-products/route.ts:798` has the four requirements documented as a code comment. Restated here:

1. **Validate pagination completed cleanly** — last page reached, no rate-limit errors anywhere in the loop. If ANY page returned 429 or partial data, abort the diff.
2. **Validate `activeIds.size` is within a sane minimum** — e.g., must be ≥ 70% of the prior known active count from DB. Sudden 80% drop should never autopilot bulk-end.
3. **Cap delta size** — if `toEnd.length / dbRows.length > 0.20` then abort and write to an alert log. Bulk-ending more than 20% of a user's listings in one run is never legitimate.
4. **Audit log every bulk-end** — write sample IDs + count + trigger reason to a `bulk_end_audit_log` table so anomalous behavior is visible.

**Additional safeguards that should ship before re-enabling:**

5. **Idempotent eBay state check** — before marking ended, do a focused `GetItem` per listing to confirm "actually no longer active". Cost: 1 call per candidate, only on the small candidate set. Worth the safety.
6. **Daily reconciliation report** — separate cron that just COUNTS active in DB vs active on eBay and alerts if delta > 5%. Would have caught this 38 days ago.
7. **Soft-end instead of hard-end** — use a `pending_end_at` column for the first detection; only flip to `ended_at` after 2 confirmations across separate cron runs.

## What's next
1. **3:00am ET cron `718dfa62`** runs the restore script — only restores listings eBay confirms still active.
2. **3:07am ET cron `15f9959c`** runs the 105-listing image repair retry.
3. Re-run the Listing Quality audit on the corrected dataset — now we get real numbers for pricing, titles, images, specifics, categories, saturation.
4. Decide whether the safeguards above warrant building before any re-enable, or whether a simpler reconciliation approach is enough.

## Key lesson
**Disabling-by-default is the right policy for any code that does bulk destructive operations against business-critical state.** The diff block at line 798 looked harmless on a 5-row test database; it was silently catastrophic on a 2,000+ row production set the moment eBay's API was anything less than perfect.
