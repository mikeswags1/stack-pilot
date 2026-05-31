# Demand Scout — PAUSED (2026-05-30)

## Status
**Paused — R&D only.** Cron disabled in `vercel.json`. Code preserved in `lib/demand-scout.ts` + `app/api/cron/demand-scout/route.ts` for future revival. **Do not market this feature.**

## What it was meant to do
Pivot sourcing from push (crawl Amazon randomly, hope it sells on eBay) to pull (find what's selling on eBay → reverse-search to an Amazon ASIN → list that). Demand-driven sourcing for higher conversion.

## What we built
- 54 curated demand seeds across eBay's high-margin buyer demographic (auto parts, tools, fishing/hunting, sporting goods, pet, garden, computer/phone accessories, hobbies).
- Browse API integration with seeded rotation cursor (`demand_scout_state` table).
- Amazon-side reverse-search: scrape first, RapidAPI fallback.
- Viability gate: Amazon cost ≤ 62% of cheapest eBay competitor → ≥25% ROI after fees.
- Full pipeline trace into `demand_scout_trace` for every candidate decision.
- Cron every 30 min on a separate route from the main niche engine.

## Why it doesn't work today
**Root cause: Browse API daily quota conflict — confirmed by the trace.**

- eBay's default Browse API limit: **5,000 calls/day per app**.
- Competition enricher consumption: **~7,680 calls/day** (every 15 min × 80 products).
- That alone is already 53% over the daily cap.
- Demand Scout fires after the enricher in the cron cycle → every Browse call returns 429 "Too many requests".
- Trace data: **8/8 seeds returned `browse_empty`** across two full days of runs. Not a code bug — a resource starvation issue.

## Verified by data
Run `r1780189238620_glj8qa` (2026-05-30):
| Stage | Result |
|---|---|
| Seeds searched | 8 |
| Browse API → empty | 8 |
| Anything past stage 1 | 0 |

Direct test of 4 different Browse API filter variants: **all 4 returned identical 429 errors.** Filter syntax confirmed innocent.

## What would have to change to revive it
1. **Higher Browse API limits** via eBay's Application Growth Check — currently declined due to dropshipping policy risk (would draw eBay scrutiny to Amazon-arbitrage app).
2. **Shared-call architecture** — refactor the competition enricher to ALSO capture demand signals during its existing Browse calls. Complex but doable. ~1-2 days work.
3. **Alternative data source** — paid third-party (Terapeak, Keepa) or custom scraping of eBay's public completed-listings pages. New infrastructure.
4. **Quota budgeting + prioritization** — formal API call budgeting so jobs share the quota fairly. Should happen anyway as part of the broader API Monitoring audit.

## Revisit when
- Account has 50+ proven sales/week (Application Growth Check becomes defensible).
- OR a sustainable API strategy is in place.
- OR core listing/pricing optimization is fully delivering and we have spare capacity for new features.

## Key lessons
1. **Observability before fixes.** Two days of guessing at fixes; one hour of instrumentation gave the definitive answer.
2. **Quota is a finite shared resource.** A new feature using the same API quota as an existing system can silently starve.
3. **Validate the cheapest stage first.** Stage 1 (Browse) was failing; stages 2-5 didn't matter.
4. **0 products in 30+ hours is not "almost working" — it's not working.** Don't soft-pedal data.
