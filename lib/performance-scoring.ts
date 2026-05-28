// Phase 2 — Product & niche performance scoring (the learning loop).
//
// Turns raw outcome data (sold/days_to_sale/watchers/refunds/reductions) into:
//   1) A per-listing performance_score (0-100) written to listed_asins
//   2) A per-ASIN listing_outcome_score (0.60-1.25) written to product_source_items
//      — this is the EXISTING multiplier that applySourceIntelligenceScores already reads,
//        so improving it here automatically reprioritizes sourcing.
//   3) Per-niche outcome metrics rolled into source_niche_intelligence so niches with real
//      sell-through get more sourcing allocation and dead niches decay.
//
// Philosophy: reward velocity + realized profit, penalize stalling + refunds/cancels.
// A product that sells in 3 days at 50% ROI should outrank one that sits 60 days unsold.

import { queryRows, sql } from '@/lib/db'
import { ensureListingOutcomeColumns } from '@/lib/listing-outcomes'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

// ────────────────────────────── Per-listing performance score ──────────────────────────────

export type ListingOutcomeSignals = {
  soldAt: string | null
  listedAt: string | null
  salePrice: number | null
  realizedProfit: number | null
  watchCount: number
  hitCount: number
  cancelCount: number
  refundCount: number
  reductionCount: number
  relistCount: number
  endedAt: string | null
}

/**
 * 0-100 listing performance score.
 *   Sold fast + profitable + low refunds → 80-100
 *   Sold slow / many reductions → 40-65
 *   Unsold but engaged (watchers) → 35-55
 *   Unsold + stale + no engagement → 0-30
 *   Cancelled/refunded → heavy penalty
 */
export function computeListingPerformanceScore(s: ListingOutcomeSignals, now = new Date()): number {
  const listedTime = s.listedAt ? new Date(s.listedAt).getTime() : null

  // ── Sold path ──
  if (s.soldAt && listedTime) {
    const daysToSale = Math.max(0, (new Date(s.soldAt).getTime() - listedTime) / 86_400_000)
    // Velocity: sold same-day = 1.0, 30+ days = ~0.1
    const velocityScore = clamp(1 - daysToSale / 30, 0.1, 1) * 45
    // Realized profit (absolute $) — $20+ = full marks
    const profitScore = s.realizedProfit != null ? clamp(s.realizedProfit / 20, 0, 1) * 30 : 15
    // Engagement contributed
    const engagementScore = clamp(s.watchCount / 10, 0, 1) * 10
    // Penalties
    const reductionPenalty = clamp(s.reductionCount / 4, 0, 1) * 8
    const refundPenalty = (s.refundCount > 0 ? 25 : 0) + (s.cancelCount > 0 ? 15 : 0)
    const relistPenalty = clamp(s.relistCount / 3, 0, 1) * 6
    return Math.round(clamp(
      15 + velocityScore + profitScore + engagementScore - reductionPenalty - refundPenalty - relistPenalty,
      0, 100,
    ))
  }

  // ── Unsold path ──
  const ageDays = listedTime ? (now.getTime() - listedTime) / 86_400_000 : 0
  // Engagement is the main positive signal for unsold listings.
  const watchScore = clamp(s.watchCount / 8, 0, 1) * 30
  const hitScore = clamp(s.hitCount / 100, 0, 1) * 15
  // Age penalty: fresh listing isn't penalized; >30d stale heavily penalized.
  const agePenalty = clamp((ageDays - 7) / 30, 0, 1) * 35
  const reductionPenalty = clamp(s.reductionCount / 4, 0, 1) * 10
  const refundPenalty = (s.refundCount > 0 ? 20 : 0) + (s.cancelCount > 0 ? 10 : 0)
  return Math.round(clamp(
    30 + watchScore + hitScore - agePenalty - reductionPenalty - refundPenalty,
    0, 100,
  ))
}

/**
 * Convert a 0-100 listing performance score (aggregated per ASIN) into the
 * 0.60-1.25 sourcing multiplier that product_source_items.listing_outcome_score expects.
 */
export function performanceToSourcingMultiplier(avgScore: number, sampleSize: number): number {
  // Low confidence when we've only seen 1 listing — pull toward neutral 1.0.
  const confidence = clamp(sampleSize / 4, 0.25, 1)
  // 50 = neutral, 100 = +0.25, 0 = -0.40
  const raw = avgScore >= 50
    ? 1 + (avgScore - 50) / 50 * 0.25
    : 1 - (50 - avgScore) / 50 * 0.40
  const blended = 1 + (raw - 1) * confidence
  return Number(clamp(blended, 0.60, 1.25).toFixed(3))
}

// ────────────────────────────── Batch: score all listings ──────────────────────────────

type ListingRow = {
  id: string | number
  listed_at: string | null
  sold_at: string | null
  sale_price: string | number | null
  realized_profit: string | number | null
  watch_count: string | number
  hit_count: string | number
  cancel_count: string | number
  refund_count: string | number
  reduction_count: string | number
  relist_count: string | number
  ended_at: string | null
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v || 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Recompute performance_score for every listing touched in the last `windowDays`
 * (or all, if windowDays omitted). Cheap: pure DB read + per-row math + batched updates.
 */
export async function scoreAllListings(opts: { windowDays?: number; limit?: number } = {}) {
  await ensureListingOutcomeColumns()
  const limit = Math.max(100, Math.min(20000, opts.limit ?? 8000))

  // Separate full queries — the neon sql tag executes immediately and does NOT support
  // nested fragment interpolation, so we can't conditionally splice a WHERE clause.
  const rows = opts.windowDays
    ? await queryRows<ListingRow>`
        SELECT id, listed_at, sold_at, sale_price, realized_profit,
               watch_count, hit_count, cancel_count, refund_count, reduction_count, relist_count, ended_at
        FROM listed_asins
        WHERE (sold_at > NOW() - (${opts.windowDays} || ' days')::interval
            OR listed_at > NOW() - (${opts.windowDays} || ' days')::interval
            OR performance_updated_at IS NULL)
        ORDER BY COALESCE(performance_updated_at, '1970-01-01') ASC
        LIMIT ${limit}
      `.catch(() => [])
    : await queryRows<ListingRow>`
        SELECT id, listed_at, sold_at, sale_price, realized_profit,
               watch_count, hit_count, cancel_count, refund_count, reduction_count, relist_count, ended_at
        FROM listed_asins
        ORDER BY COALESCE(performance_updated_at, '1970-01-01') ASC
        LIMIT ${limit}
      `.catch(() => [])

  let updated = 0
  for (const row of rows) {
    const score = computeListingPerformanceScore({
      soldAt: row.sold_at,
      listedAt: row.listed_at,
      salePrice: row.sale_price != null ? toNum(row.sale_price) : null,
      realizedProfit: row.realized_profit != null ? toNum(row.realized_profit) : null,
      watchCount: toNum(row.watch_count),
      hitCount: toNum(row.hit_count),
      cancelCount: toNum(row.cancel_count),
      refundCount: toNum(row.refund_count),
      reductionCount: toNum(row.reduction_count),
      relistCount: toNum(row.relist_count),
      endedAt: row.ended_at,
    })
    await sql`
      UPDATE listed_asins
      SET performance_score = ${score}, performance_updated_at = NOW()
      WHERE id = ${row.id}
    `.catch(() => {})
    updated++
  }
  return { scored: updated }
}

// ────────────────────────────── Bridge: feed sourcing intelligence ──────────────────────────────

/**
 * Aggregate listing performance per ASIN and write the sourcing multiplier into
 * product_source_items.listing_outcome_score. This is what makes fast-sellers get sourced
 * more and stale/refunded products get sourced less.
 *
 * Replaces the queue-completion-only logic of the old applyListingOutcomeFeedback with
 * real sell-through signals (while still being additive — both can run).
 */
export async function applyPerformanceToSourcing() {
  await ensureListingOutcomeColumns()

  const rows = await queryRows<{ asin: string; avg_score: string | number; sample: string | number }>`
    SELECT asin,
           AVG(performance_score) AS avg_score,
           COUNT(*) AS sample
    FROM listed_asins
    WHERE performance_score IS NOT NULL
      AND asin IS NOT NULL
      AND (sold_at IS NOT NULL OR listed_at > NOW() - INTERVAL '90 days')
    GROUP BY asin
  `.catch(() => [])

  let updated = 0
  for (const row of rows) {
    const multiplier = performanceToSourcingMultiplier(toNum(row.avg_score), toNum(row.sample))
    const result = await sql`
      UPDATE product_source_items
      SET listing_outcome_score = ${multiplier}
      WHERE asin = ${row.asin}
        AND listing_outcome_score IS DISTINCT FROM ${multiplier}
    `.catch(() => null)
    if (result) updated++
  }
  return { asinsUpdated: updated, asinsConsidered: rows.length }
}

// ────────────────────────────── Niche outcome metrics ──────────────────────────────

export async function ensureNicheOutcomeColumns() {
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS sold_30d INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS avg_days_to_sale NUMERIC(8,2)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS sell_through_rate NUMERIC(6,4)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS realized_profit_30d NUMERIC(12,2) NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS cancel_rate NUMERIC(6,4) NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS refund_rate NUMERIC(6,4) NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS avg_performance_score NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS outcome_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1`.catch(() => {})
}

/**
 * Per-niche sell-through aggregation → writes into source_niche_intelligence.
 * Also computes an outcome_multiplier (0.70-1.30) that boosts sourcing for niches with
 * proven sell-through and decays niches that list but never sell.
 */
export async function applyNicheOutcomeWeighting() {
  await ensureNicheOutcomeColumns()

  const rows = await queryRows<{
    niche: string
    listed_30d: string | number
    sold_30d: string | number
    avg_days_to_sale: string | number | null
    realized_profit_30d: string | number | null
    cancels: string | number
    refunds: string | number
    avg_perf: string | number | null
  }>`
    SELECT
      COALESCE(NULLIF(niche, ''), 'Unassigned') AS niche,
      COUNT(*) FILTER (WHERE listed_at > NOW() - INTERVAL '30 days')::int AS listed_30d,
      COUNT(*) FILTER (WHERE sold_at > NOW() - INTERVAL '30 days')::int AS sold_30d,
      ROUND(AVG(EXTRACT(EPOCH FROM (sold_at - listed_at)) / 86400.0)
        FILTER (WHERE sold_at IS NOT NULL AND listed_at IS NOT NULL), 2) AS avg_days_to_sale,
      ROUND(COALESCE(SUM(realized_profit) FILTER (WHERE sold_at > NOW() - INTERVAL '30 days'), 0), 2) AS realized_profit_30d,
      COALESCE(SUM(cancel_count), 0)::int AS cancels,
      COALESCE(SUM(refund_count), 0)::int AS refunds,
      ROUND(AVG(performance_score), 2) AS avg_perf
    FROM listed_asins
    GROUP BY COALESCE(NULLIF(niche, ''), 'Unassigned')
  `.catch(() => [])

  let updated = 0
  for (const row of rows) {
    const listed30d = toNum(row.listed_30d)
    const sold30d = toNum(row.sold_30d)
    const cancels = toNum(row.cancels)
    const refunds = toNum(row.refunds)
    const sellThrough = listed30d > 0 ? sold30d / listed30d : 0
    const cancelRate = sold30d + cancels > 0 ? cancels / (sold30d + cancels) : 0
    const refundRate = sold30d > 0 ? refunds / sold30d : 0
    const avgDaysToSale = row.avg_days_to_sale != null ? toNum(row.avg_days_to_sale) : null
    const realizedProfit30d = toNum(row.realized_profit_30d)
    const avgPerf = row.avg_perf != null ? toNum(row.avg_perf) : null

    // outcome_multiplier: reward sell-through + profit, penalize cancels/refunds.
    // Confidence-weighted by sample size so a single sale doesn't swing a niche.
    const confidence = clamp(listed30d / 10, 0.2, 1)
    const sellThroughBoost = clamp(sellThrough / 0.4, 0, 1) * 0.20      // 40% sell-through = full boost
    const profitBoost = clamp(realizedProfit30d / 200, 0, 1) * 0.10     // $200 realized = full boost
    const velocityBoost = avgDaysToSale != null ? clamp(1 - avgDaysToSale / 21, 0, 1) * 0.08 : 0
    const cancelPenalty = clamp(cancelRate / 0.15, 0, 1) * 0.18         // 15% cancel rate = full penalty
    const refundPenalty = clamp(refundRate / 0.10, 0, 1) * 0.15         // 10% refund rate = full penalty
    // Decay: niche that listed a lot but sold nothing in 30d
    const deadPenalty = (listed30d >= 10 && sold30d === 0) ? 0.15 : 0

    const rawMultiplier = 1 + sellThroughBoost + profitBoost + velocityBoost - cancelPenalty - refundPenalty - deadPenalty
    const outcomeMultiplier = Number(clamp(1 + (rawMultiplier - 1) * confidence, 0.70, 1.30).toFixed(3))

    await sql`
      UPDATE source_niche_intelligence
      SET
        sold_30d = ${sold30d},
        avg_days_to_sale = ${avgDaysToSale},
        sell_through_rate = ${Number(sellThrough.toFixed(4))},
        realized_profit_30d = ${realizedProfit30d},
        cancel_rate = ${Number(cancelRate.toFixed(4))},
        refund_rate = ${Number(refundRate.toFixed(4))},
        avg_performance_score = ${avgPerf},
        outcome_multiplier = ${outcomeMultiplier},
        updated_at = NOW()
      WHERE niche = ${row.niche}
    `.catch(() => {})
    updated++
  }
  return { nichesUpdated: updated }
}

// ────────────────────────────── Top performers (read) ──────────────────────────────

export async function getTopPerformers() {
  await ensureListingOutcomeColumns()
  await ensureNicheOutcomeColumns()

  const [bestNiches, worstNiches, fastestListings, topProducts, staleListings, highRefundNiches] = await Promise.all([
    // Best niches by sell-through (min 5 listings for signal)
    queryRows`
      SELECT niche, listed_30d, sold_30d, sell_through_rate, avg_days_to_sale,
             realized_profit_30d, outcome_multiplier, avg_performance_score
      FROM source_niche_intelligence
      WHERE listed_30d >= 5
      ORDER BY sell_through_rate DESC, realized_profit_30d DESC
      LIMIT 10
    `.catch(() => []),
    // Worst niches: listed a lot, sold little
    queryRows`
      SELECT niche, listed_30d, sold_30d, sell_through_rate, avg_days_to_sale, outcome_multiplier
      FROM source_niche_intelligence
      WHERE listed_30d >= 8
      ORDER BY sell_through_rate ASC, listed_30d DESC
      LIMIT 10
    `.catch(() => []),
    // Fastest-moving listings (sold quickest)
    queryRows`
      SELECT asin, title, niche, ebay_price, sale_price, realized_profit,
             ROUND(EXTRACT(EPOCH FROM (sold_at - listed_at)) / 86400.0, 1) AS days_to_sale,
             watch_count, performance_score
      FROM listed_asins
      WHERE sold_at IS NOT NULL AND listed_at IS NOT NULL
        AND sold_at > NOW() - INTERVAL '30 days'
      ORDER BY (sold_at - listed_at) ASC
      LIMIT 15
    `.catch(() => []),
    // Top products by performance score
    queryRows`
      SELECT asin, title, niche, ebay_price, realized_profit, watch_count, hit_count,
             performance_score, sold_at, quantity_sold
      FROM listed_asins
      WHERE performance_score IS NOT NULL
      ORDER BY performance_score DESC, realized_profit DESC NULLS LAST
      LIMIT 15
    `.catch(() => []),
    // Worst stale listings: active a long time, low engagement, unsold
    queryRows`
      SELECT asin, title, niche, ebay_price, watch_count, hit_count, reduction_count,
             ROUND(EXTRACT(EPOCH FROM (NOW() - listed_at)) / 86400.0, 0) AS age_days,
             performance_score
      FROM listed_asins
      WHERE ended_at IS NULL AND sold_at IS NULL
        AND listed_at < NOW() - INTERVAL '30 days'
      ORDER BY performance_score ASC NULLS FIRST, listed_at ASC
      LIMIT 15
    `.catch(() => []),
    // Highest refund/cancel niches
    queryRows`
      SELECT niche, sold_30d, cancel_rate, refund_rate, listed_30d
      FROM source_niche_intelligence
      WHERE (cancel_rate > 0 OR refund_rate > 0) AND listed_30d >= 3
      ORDER BY (cancel_rate + refund_rate) DESC
      LIMIT 10
    `.catch(() => []),
  ])

  return { bestNiches, worstNiches, fastestListings, topProducts, staleListings, highRefundNiches }
}
