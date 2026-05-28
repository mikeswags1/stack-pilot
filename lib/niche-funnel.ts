// Phase 1 — Niche funnel data assembly.
//
// Joins source_niche_intelligence (already aggregated) with:
//   - listing_failure_log (Phase 0) — failures by error_code, per niche, last 24h
//   - amazon_product_cache + product_source_items — enriched product counts
//   - listed_asins — last successful listing timestamp
//   - product_source_niches — paused state
//
// Produces a per-niche row ready to feed into computeLifecycleState. Also persists the
// computed state + diagnostics back into source_niche_intelligence (new columns).

import { queryRows, sql } from '@/lib/db'
import { ensureSourceIntelligenceTables } from '@/lib/source-intelligence'
import { ensureQuotaTables } from '@/lib/quota-tracker'
import {
  computeLifecycleState,
  type Diagnostic,
  type LifecycleAssessment,
  type LifecycleState,
  type NicheFunnelInput,
} from '@/lib/niche-lifecycle'

export async function ensureNicheLifecycleColumns() {
  await ensureSourceIntelligenceTables()
  await ensureQuotaTables()
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active'`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS enriched_products INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS preflight_failures_24h INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS last_successful_listing_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS top_failure_codes JSONB NOT NULL DEFAULT '[]'::jsonb`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS source_niche_intelligence_state_idx ON source_niche_intelligence (lifecycle_state, health_score ASC)`.catch(() => {})
}

type NicheJoinRow = {
  niche: string
  enriched_products: string | number
  preflight_failures_24h: string | number
  last_successful_listing_at: string | null
  paused: boolean | null
  top_failure_codes: unknown // jsonb array of { code, count }
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(n) ? n : 0
}

function toIso(value: unknown): string | null {
  if (!value) return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Gathers the funnel signals NOT already in source_niche_intelligence, joined per niche.
 * Returns a map keyed by niche name.
 */
export async function loadNicheFunnelSignals(): Promise<Map<string, {
  enrichedProducts: number
  preflightFailures24h: number
  lastSuccessfulListingAt: string | null
  paused: boolean
  topFailureCodes: Array<{ code: string; count: number }>
}>> {
  await ensureNicheLifecycleColumns()

  const rows = await queryRows<NicheJoinRow>`
    WITH enrichment AS (
      SELECT
        COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned') AS niche,
        COUNT(*) FILTER (
          WHERE psi.active = TRUE
            AND apc.asin IS NOT NULL
            AND COALESCE(apc.available, TRUE) = TRUE
            AND jsonb_typeof(apc.images) = 'array'
            AND jsonb_array_length(apc.images) >= 2
        )::int AS enriched_products
      FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      GROUP BY COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned')
    ),
    failures AS (
      SELECT
        COALESCE(NULLIF(niche, ''), 'Unassigned') AS niche,
        COUNT(*)::int AS preflight_failures_24h,
        jsonb_agg(json_build_object('code', error_code, 'count', cnt) ORDER BY cnt DESC) AS top_failure_codes
      FROM (
        SELECT niche, error_code, COUNT(*)::int AS cnt
        FROM listing_failure_log
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY niche, error_code
      ) f
      GROUP BY COALESCE(NULLIF(niche, ''), 'Unassigned')
    ),
    last_listed AS (
      SELECT
        COALESCE(NULLIF(niche, ''), 'Unassigned') AS niche,
        MAX(listed_at) AS last_successful_listing_at
      FROM listed_asins
      WHERE ebay_listing_id IS NOT NULL
      GROUP BY COALESCE(NULLIF(niche, ''), 'Unassigned')
    ),
    pause_state AS (
      SELECT name AS niche, NOT active AS paused
      FROM product_source_niches
    )
    SELECT
      COALESCE(e.niche, f.niche, l.niche, p.niche) AS niche,
      COALESCE(e.enriched_products, 0) AS enriched_products,
      COALESCE(f.preflight_failures_24h, 0) AS preflight_failures_24h,
      l.last_successful_listing_at,
      COALESCE(p.paused, FALSE) AS paused,
      COALESCE(f.top_failure_codes, '[]'::jsonb) AS top_failure_codes
    FROM enrichment e
    FULL JOIN failures f ON f.niche = e.niche
    FULL JOIN last_listed l ON l.niche = COALESCE(e.niche, f.niche)
    FULL JOIN pause_state p ON p.niche = COALESCE(e.niche, f.niche, l.niche)
    WHERE COALESCE(e.niche, f.niche, l.niche, p.niche) IS NOT NULL
  `.catch(() => [])

  const map = new Map<string, {
    enrichedProducts: number
    preflightFailures24h: number
    lastSuccessfulListingAt: string | null
    paused: boolean
    topFailureCodes: Array<{ code: string; count: number }>
  }>()

  for (const row of rows) {
    const topCodes = Array.isArray(row.top_failure_codes)
      ? (row.top_failure_codes as Array<{ code?: string; count?: number }>)
          .map((entry) => ({ code: String(entry?.code || ''), count: toNumber(entry?.count) }))
          .filter((entry) => entry.code.length > 0)
      : []
    map.set(row.niche, {
      enrichedProducts: toNumber(row.enriched_products),
      preflightFailures24h: toNumber(row.preflight_failures_24h),
      lastSuccessfulListingAt: toIso(row.last_successful_listing_at),
      paused: !!row.paused,
      topFailureCodes: topCodes,
    })
  }

  return map
}

export type NicheFunnelRow = {
  niche: string
  state: LifecycleState
  reason: string
  diagnostics: Diagnostic[]
  // Funnel counts (in pipeline order)
  activeProducts: number          // sourced (in source pool, active)
  enrichedProducts: number        // enriched (have cache + 2+ images)
  readyProducts: number           // preflight-passed (passes all gates per refresh logic)
  cacheProducts: number           // in niche product_cache (dashboard queue)
  activeListings: number          // currently live on eBay
  // Outcomes
  listed30d: number
  completedQueue30d: number
  failedQueue30d: number
  preflightFailures24h: number
  topFailureCodes: Array<{ code: string; count: number }>
  // Quality
  avgProfit: number
  avgRoi: number
  healthScore: number
  // Timestamps
  lastSuccessfulListingAt: string | null
  lastCacheAt: string | null
  lastSeenAt: string | null
  paused: boolean
}

type IntelligenceQueryRow = {
  niche: string
  active_products: string | number
  ready_products: string | number
  cache_products: string | number
  stale_products: string | number
  unavailable_products: string | number
  listed_30d: string | number
  active_listings: string | number
  completed_queue_30d: string | number
  failed_queue_30d: string | number
  avg_profit: string | number | null
  avg_roi: string | number | null
  health_score: string | number | null
  last_cache_at: string | null
  last_seen_at: string | null
}

/**
 * Computes lifecycle state + diagnostics for every niche in source_niche_intelligence and
 * persists the result. Returns the resulting rows in a UI-friendly shape.
 *
 * Also: when an assessment says recommendPause and the niche is currently active in
 * product_source_niches, this writes paused state via setCustomSourceNicheActive(name, false)
 * — but ONLY when called with `autoPauseExpired = true` (cron use). Manual refresh leaves
 * the active flag alone.
 */
export async function refreshNicheLifecycle(opts: { autoPauseExpired?: boolean } = {}): Promise<{
  rows: NicheFunnelRow[]
  pausedSeasonalNiches: string[]
}> {
  await ensureNicheLifecycleColumns()

  const [intelRows, signals] = await Promise.all([
    queryRows<IntelligenceQueryRow>`
      SELECT
        niche, active_products, ready_products, cache_products, stale_products,
        unavailable_products, listed_30d, active_listings, completed_queue_30d,
        failed_queue_30d, avg_profit, avg_roi, health_score, last_cache_at, last_seen_at
      FROM source_niche_intelligence
    `.catch(() => []),
    loadNicheFunnelSignals(),
  ])

  const results: NicheFunnelRow[] = []
  const pausedSeasonalNiches: string[] = []

  for (const intel of intelRows) {
    const niche = intel.niche
    const signal = signals.get(niche) || {
      enrichedProducts: 0,
      preflightFailures24h: 0,
      lastSuccessfulListingAt: null,
      paused: false,
      topFailureCodes: [],
    }

    const funnelInput: NicheFunnelInput = {
      niche,
      activeProducts: toNumber(intel.active_products),
      readyProducts: toNumber(intel.ready_products),
      cacheProducts: toNumber(intel.cache_products),
      staleProducts: toNumber(intel.stale_products),
      unavailableProducts: toNumber(intel.unavailable_products),
      listed30d: toNumber(intel.listed_30d),
      completedQueue30d: toNumber(intel.completed_queue_30d),
      failedQueue30d: toNumber(intel.failed_queue_30d),
      avgProfit: toNumber(intel.avg_profit),
      avgRoi: toNumber(intel.avg_roi),
      healthScore: toNumber(intel.health_score),
      lastCacheAt: toIso(intel.last_cache_at),
      lastSeenAt: toIso(intel.last_seen_at),
      lastSuccessfulListingAt: signal.lastSuccessfulListingAt,
      enrichedProducts: signal.enrichedProducts,
      preflightFailures24h: signal.preflightFailures24h,
      topFailureCodes: signal.topFailureCodes,
      paused: signal.paused,
    }

    const assessment: LifecycleAssessment = computeLifecycleState(funnelInput)

    // Persist back to source_niche_intelligence
    await sql`
      UPDATE source_niche_intelligence
      SET
        lifecycle_state = ${assessment.state},
        lifecycle_reason = ${assessment.reason.slice(0, 500)},
        diagnostics = ${JSON.stringify(assessment.diagnostics)}::jsonb,
        enriched_products = ${signal.enrichedProducts},
        preflight_failures_24h = ${signal.preflightFailures24h},
        last_successful_listing_at = ${signal.lastSuccessfulListingAt},
        top_failure_codes = ${JSON.stringify(signal.topFailureCodes)}::jsonb,
        updated_at = NOW()
      WHERE niche = ${niche}
    `.catch(() => {})

    // Auto-pause seasonal_expired if requested (cron use only)
    if (opts.autoPauseExpired && assessment.recommendPause && assessment.state === 'seasonal_expired' && !signal.paused) {
      const { setCustomSourceNicheActive } = await import('@/lib/source-niches')
      await setCustomSourceNicheActive(niche, false).catch(() => {})
      pausedSeasonalNiches.push(niche)
    }

    results.push({
      niche,
      state: assessment.state,
      reason: assessment.reason,
      diagnostics: assessment.diagnostics,
      activeProducts: funnelInput.activeProducts,
      enrichedProducts: signal.enrichedProducts,
      readyProducts: funnelInput.readyProducts,
      cacheProducts: funnelInput.cacheProducts,
      activeListings: toNumber(intel.active_listings),
      listed30d: funnelInput.listed30d,
      completedQueue30d: funnelInput.completedQueue30d,
      failedQueue30d: funnelInput.failedQueue30d,
      preflightFailures24h: signal.preflightFailures24h,
      topFailureCodes: signal.topFailureCodes,
      avgProfit: funnelInput.avgProfit,
      avgRoi: funnelInput.avgRoi,
      healthScore: funnelInput.healthScore,
      lastSuccessfulListingAt: signal.lastSuccessfulListingAt,
      lastCacheAt: funnelInput.lastCacheAt,
      lastSeenAt: funnelInput.lastSeenAt,
      paused: signal.paused,
    })
  }

  return { rows: results, pausedSeasonalNiches }
}

/**
 * Read-only: returns the most recently persisted lifecycle state for all niches.
 * Used by the admin UI between refresh runs.
 */
export async function getNicheLifecycleRows(): Promise<NicheFunnelRow[]> {
  await ensureNicheLifecycleColumns()

  const rows = await queryRows<IntelligenceQueryRow & {
    lifecycle_state: string
    lifecycle_reason: string | null
    diagnostics: unknown
    enriched_products: string | number
    preflight_failures_24h: string | number
    last_successful_listing_at: string | null
    top_failure_codes: unknown
  }>`
    SELECT
      niche, active_products, ready_products, cache_products, stale_products,
      unavailable_products, listed_30d, active_listings, completed_queue_30d,
      failed_queue_30d, avg_profit, avg_roi, health_score, last_cache_at, last_seen_at,
      lifecycle_state, lifecycle_reason, diagnostics,
      enriched_products, preflight_failures_24h, last_successful_listing_at, top_failure_codes
    FROM source_niche_intelligence
    ORDER BY
      CASE lifecycle_state
        WHEN 'active' THEN 1
        WHEN 'watch' THEN 2
        WHEN 'stale' THEN 3
        WHEN 'seasonal_expired' THEN 4
        WHEN 'paused' THEN 5
        WHEN 'retired' THEN 6
        ELSE 7 END,
      health_score DESC,
      ready_products DESC
  `.catch(() => [])

  // Reuse paused-state from product_source_niches (in case admin paused but lifecycle hasn't refreshed)
  const pauseRows = await queryRows<{ name: string; paused: boolean }>`
    SELECT name, NOT active AS paused FROM product_source_niches
  `.catch(() => [])
  const pauseMap = new Map(pauseRows.map((r) => [r.name, !!r.paused]))

  return rows.map((row) => {
    const diagnostics = Array.isArray(row.diagnostics) ? (row.diagnostics as Diagnostic[]) : []
    const topCodes = Array.isArray(row.top_failure_codes)
      ? (row.top_failure_codes as Array<{ code?: string; count?: number }>)
          .map((e) => ({ code: String(e?.code || ''), count: toNumber(e?.count) }))
          .filter((e) => e.code.length > 0)
      : []
    return {
      niche: row.niche,
      state: row.lifecycle_state as LifecycleState,
      reason: row.lifecycle_reason || '',
      diagnostics,
      activeProducts: toNumber(row.active_products),
      enrichedProducts: toNumber(row.enriched_products),
      readyProducts: toNumber(row.ready_products),
      cacheProducts: toNumber(row.cache_products),
      activeListings: toNumber(row.active_listings),
      listed30d: toNumber(row.listed_30d),
      completedQueue30d: toNumber(row.completed_queue_30d),
      failedQueue30d: toNumber(row.failed_queue_30d),
      preflightFailures24h: toNumber(row.preflight_failures_24h),
      topFailureCodes: topCodes,
      avgProfit: toNumber(row.avg_profit),
      avgRoi: toNumber(row.avg_roi),
      healthScore: toNumber(row.health_score),
      lastSuccessfulListingAt: toIso(row.last_successful_listing_at),
      lastCacheAt: toIso(row.last_cache_at),
      lastSeenAt: toIso(row.last_seen_at),
      paused: pauseMap.get(row.niche) ?? false,
    }
  })
}
