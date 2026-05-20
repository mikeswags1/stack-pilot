import { queryRows, sql } from '@/lib/db'
import { ensureAutoListingTables } from '@/lib/auto-listing/db'
import { ensureProductSourceTables } from '@/lib/product-source-engine'
import { enrichCompetitionData } from '@/lib/ebay-competition'

export type SourceEngineRunStatus = 'success' | 'failed' | 'partial'

export type SourceEngineRunInput = {
  mode: string
  trigger: string
  status: SourceEngineRunStatus
  niches?: string[]
  startedAt: number
  metrics?: Record<string, unknown>
  recommendations?: Array<{ type: string; message: string; niche?: string }>
  error?: string
}

type NicheSignalRow = {
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
  avg_score: string | number | null
  last_cache_at: string | null
  last_seen_at: string | null
}

type SourceRunRow = {
  id: string | number
  mode: string
  trigger: string
  status: string
  products_found: string | number
  products_rejected: string | number
  ready_to_list: string | number
  duration_ms: string | number
  created_at: string | null
  error: string | null
}

type SourceRecommendationRow = {
  niche: string
  active_products: string | number
  ready_products: string | number
  cache_products: string | number
  stale_products: string | number
  unavailable_products: string | number
  failed_queue_30d: string | number
  completed_queue_30d: string | number
  avg_profit: string | number | null
  avg_roi: string | number | null
  health_score: string | number | null
  learning_multiplier: string | number | null
  recommended_action: string | null
  last_cache_at: string | null
  updated_at: string | null
}

type SourceAutopilotLockRow = {
  name: string
  locked_until: string | null
  last_started_at: string | null
  last_reason: string | null
  last_niches: unknown
  updated_at: string | null
}

function toNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function toIso(value: unknown) {
  if (!value) return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function parseStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item || '')).filter(Boolean)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((item) => String(item || '')).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

function staleHours(value: string | null) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 9999
  return Math.max(0, (Date.now() - date.getTime()) / 36e5)
}

function getRecommendedAction(input: {
  readyProducts: number
  cacheProducts: number
  staleProducts: number
  unavailableProducts: number
  failedQueue30d: number
  completedQueue30d: number
  avgProfit: number
  avgRoi: number
  lastCacheAt: string | null
}) {
  if (input.readyProducts < 30) return 'Refresh this niche: fewer than 30 ready-to-list products.'
  if (input.cacheProducts < 30) return 'Rebuild product cache: dashboard queue is below 30 products.'
  if (staleHours(input.lastCacheAt) > 48) return 'Refresh stale cache: no fresh niche cache in over 48 hours.'
  if (input.unavailableProducts > Math.max(5, input.readyProducts * 0.15)) return 'Purge unavailable ASINs and refill with fresh Amazon matches.'
  if (input.failedQueue30d > input.completedQueue30d + 4) return 'Review listing blockers for this niche before scaling.'
  if (input.avgProfit > 0 && input.avgProfit < 5) return 'Improve margin: average profit is too thin.'
  if (input.avgRoi > 0 && input.avgRoi < 35) return 'Improve ROI: products are below the target sourcing band.'
  if (input.staleProducts > Math.max(20, input.readyProducts * 0.5)) return 'Refresh stale source rows and reprice this niche.'
  return 'Healthy. Keep rotating and scale when demand signals stay strong.'
}

function getHealthScore(input: {
  readyProducts: number
  cacheProducts: number
  staleProducts: number
  unavailableProducts: number
  failedQueue30d: number
  completedQueue30d: number
  avgProfit: number
  avgRoi: number
  avgScore: number
  lastCacheAt: string | null
}) {
  const readyScore = clamp(input.readyProducts / 30, 0, 1) * 32
  const cacheScore = clamp(input.cacheProducts / 30, 0, 1) * 18
  const freshnessScore = clamp(1 - staleHours(input.lastCacheAt) / 72, 0, 1) * 14
  const profitScore = clamp(input.avgProfit / 18, 0, 1) * 13
  const roiScore = clamp(input.avgRoi / 65, 0, 1) * 10
  const scoreQuality = clamp(input.avgScore / 180, 0, 1) * 8
  const outcomeScore = clamp((input.completedQueue30d - input.failedQueue30d) / 12, -1, 1) * 5
  const stalePenalty = clamp(input.staleProducts / Math.max(input.readyProducts + input.staleProducts, 1), 0, 1) * 10
  const unavailablePenalty = clamp(input.unavailableProducts / Math.max(input.readyProducts, 1), 0, 1) * 14
  return Math.round(clamp(
    readyScore + cacheScore + freshnessScore + profitScore + roiScore + scoreQuality + outcomeScore - stalePenalty - unavailablePenalty,
    0,
    100
  ))
}

function getLearningMultiplier(input: {
  listed30d: number
  completedQueue30d: number
  failedQueue30d: number
  unavailableProducts: number
  avgProfit: number
  avgRoi: number
  healthScore: number
}) {
  const activityBoost = clamp(input.listed30d / 30, 0, 1) * 0.09
  const completionBoost = clamp(input.completedQueue30d / 20, 0, 1) * 0.08
  const marginBoost = clamp((input.avgProfit - 8) / 25, 0, 1) * 0.08
  const roiBoost = clamp((input.avgRoi - 45) / 80, 0, 1) * 0.08
  const healthBoost = clamp((input.healthScore - 70) / 30, 0, 1) * 0.08
  const failPenalty = clamp(input.failedQueue30d / Math.max(input.completedQueue30d + 1, 1), 0, 1) * 0.18
  const availabilityPenalty = clamp(input.unavailableProducts / 40, 0, 1) * 0.12
  return Number(clamp(1 + activityBoost + completionBoost + marginBoost + roiBoost + healthBoost - failPenalty - availabilityPenalty, 0.72, 1.35).toFixed(3))
}

export async function ensureSourceIntelligenceTables() {
  await Promise.all([
    ensureProductSourceTables().catch(() => {}),
    ensureAutoListingTables().catch(() => {}),
  ])

  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS intelligence_score NUMERIC(12,2)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS source_quality TEXT NOT NULL DEFAULT 'candidate'`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS last_intelligence_at TIMESTAMPTZ`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_intelligence_idx ON product_source_items (intelligence_score DESC NULLS LAST)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_quality_idx ON product_source_items (active, source_quality, intelligence_score DESC NULLS LAST)`.catch(() => {})

  await sql`
    CREATE TABLE IF NOT EXISTS source_engine_runs (
      id BIGSERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      niches JSONB NOT NULL DEFAULT '[]'::jsonb,
      products_found INTEGER NOT NULL DEFAULT 0,
      products_rejected INTEGER NOT NULL DEFAULT 0,
      ready_to_list INTEGER NOT NULL DEFAULT 0,
      stale_products INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS source_engine_runs_created_idx ON source_engine_runs (created_at DESC)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS source_engine_runs_status_idx ON source_engine_runs (status, created_at DESC)`.catch(() => {})

  await sql`
    CREATE TABLE IF NOT EXISTS source_niche_intelligence (
      niche TEXT PRIMARY KEY,
      active_products INTEGER NOT NULL DEFAULT 0,
      ready_products INTEGER NOT NULL DEFAULT 0,
      cache_products INTEGER NOT NULL DEFAULT 0,
      stale_products INTEGER NOT NULL DEFAULT 0,
      unavailable_products INTEGER NOT NULL DEFAULT 0,
      listed_30d INTEGER NOT NULL DEFAULT 0,
      active_listings INTEGER NOT NULL DEFAULT 0,
      completed_queue_30d INTEGER NOT NULL DEFAULT 0,
      failed_queue_30d INTEGER NOT NULL DEFAULT 0,
      avg_profit NUMERIC(10,2) NOT NULL DEFAULT 0,
      avg_roi NUMERIC(8,2) NOT NULL DEFAULT 0,
      avg_score NUMERIC(12,2) NOT NULL DEFAULT 0,
      health_score NUMERIC(6,2) NOT NULL DEFAULT 0,
      learning_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1,
      recommended_action TEXT,
      last_cache_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS source_niche_intelligence_health_idx ON source_niche_intelligence (health_score ASC, ready_products ASC)`.catch(() => {})

  await sql`
    CREATE TABLE IF NOT EXISTS source_autopilot_locks (
      name TEXT PRIMARY KEY,
      locked_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_started_at TIMESTAMPTZ,
      last_reason TEXT,
      last_niches JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
}

export async function refreshSourceIntelligenceState(options: { applyScores?: boolean } = {}) {
  await ensureSourceIntelligenceTables()

  const rows = await queryRows<NicheSignalRow>`
    WITH source AS (
      SELECT
        COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned') AS niche,
        COUNT(*) FILTER (WHERE psi.active = TRUE)::int AS active_products,
        COUNT(*) FILTER (
          WHERE psi.active = TRUE
            AND apc.asin IS NOT NULL
            AND apc.available = TRUE
            AND psi.last_seen_at > NOW() - INTERVAL '21 days'
            AND psi.profit >= 4
            AND psi.roi >= 30
            AND psi.risk <> 'HIGH'
            AND psi.image_url IS NOT NULL
            AND psi.image_url <> ''
            AND jsonb_typeof(apc.images) = 'array'
            AND jsonb_array_length(apc.images) >= 2
        )::int AS ready_products,
        COUNT(*) FILTER (WHERE psi.active = TRUE AND psi.last_seen_at < NOW() - INTERVAL '7 days')::int AS stale_products,
        COUNT(*) FILTER (WHERE COALESCE(apc.available, TRUE) = FALSE)::int AS unavailable_products,
        ROUND(AVG(psi.profit) FILTER (WHERE psi.active = TRUE), 2) AS avg_profit,
        ROUND(AVG(psi.roi) FILTER (WHERE psi.active = TRUE), 2) AS avg_roi,
        ROUND(AVG(psi.total_score) FILTER (WHERE psi.active = TRUE), 2) AS avg_score,
        MAX(psi.last_seen_at) FILTER (WHERE psi.active = TRUE) AS last_seen_at
      FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      GROUP BY COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned')
    ),
    cache AS (
      SELECT
        niche,
        CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) ELSE 0 END AS cache_products,
        cached_at AS last_cache_at
      FROM product_cache
      WHERE niche NOT IN ('__continuous_listing__', '__cursor__')
    ),
    listed AS (
      SELECT
        COALESCE(NULLIF(niche, ''), 'Unassigned') AS niche,
        COUNT(*) FILTER (WHERE listed_at > NOW() - INTERVAL '30 days')::int AS listed_30d,
        COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS active_listings
      FROM listed_asins
      GROUP BY COALESCE(NULLIF(niche, ''), 'Unassigned')
    ),
    queue AS (
      SELECT
        COALESCE(NULLIF(source_niche, ''), 'Unassigned') AS niche,
        COUNT(*) FILTER (WHERE status = 'completed' AND listed_at > NOW() - INTERVAL '30 days')::int AS completed_queue_30d,
        COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '30 days')::int AS failed_queue_30d
      FROM auto_listing_queue
      GROUP BY COALESCE(NULLIF(source_niche, ''), 'Unassigned')
    )
    SELECT
      COALESCE(source.niche, cache.niche, listed.niche, queue.niche) AS niche,
      COALESCE(source.active_products, 0)::int AS active_products,
      COALESCE(source.ready_products, 0)::int AS ready_products,
      COALESCE(cache.cache_products, 0)::int AS cache_products,
      COALESCE(source.stale_products, 0)::int AS stale_products,
      COALESCE(source.unavailable_products, 0)::int AS unavailable_products,
      COALESCE(listed.listed_30d, 0)::int AS listed_30d,
      COALESCE(listed.active_listings, 0)::int AS active_listings,
      COALESCE(queue.completed_queue_30d, 0)::int AS completed_queue_30d,
      COALESCE(queue.failed_queue_30d, 0)::int AS failed_queue_30d,
      COALESCE(source.avg_profit, 0) AS avg_profit,
      COALESCE(source.avg_roi, 0) AS avg_roi,
      COALESCE(source.avg_score, 0) AS avg_score,
      cache.last_cache_at,
      source.last_seen_at
    FROM source
    FULL JOIN cache ON cache.niche = source.niche
    FULL JOIN listed ON listed.niche = COALESCE(source.niche, cache.niche)
    FULL JOIN queue ON queue.niche = COALESCE(source.niche, cache.niche, listed.niche)
    WHERE COALESCE(source.niche, cache.niche, listed.niche, queue.niche) IS NOT NULL
      AND COALESCE(source.niche, cache.niche, listed.niche, queue.niche) <> 'Unassigned'
  `.catch(() => [])

  const normalized = rows.map((row) => {
    const readyProducts = toNumber(row.ready_products)
    const cacheProducts = toNumber(row.cache_products)
    const staleProducts = toNumber(row.stale_products)
    const unavailableProducts = toNumber(row.unavailable_products)
    const failedQueue30d = toNumber(row.failed_queue_30d)
    const completedQueue30d = toNumber(row.completed_queue_30d)
    const listed30d = toNumber(row.listed_30d)
    const avgProfit = toNumber(row.avg_profit)
    const avgRoi = toNumber(row.avg_roi)
    const avgScore = toNumber(row.avg_score)
    const lastCacheAt = toIso(row.last_cache_at)
    const healthScore = getHealthScore({
      readyProducts,
      cacheProducts,
      staleProducts,
      unavailableProducts,
      failedQueue30d,
      completedQueue30d,
      avgProfit,
      avgRoi,
      avgScore,
      lastCacheAt,
    })
    const learningMultiplier = getLearningMultiplier({
      listed30d,
      completedQueue30d,
      failedQueue30d,
      unavailableProducts,
      avgProfit,
      avgRoi,
      healthScore,
    })
    return {
      niche: row.niche,
      activeProducts: toNumber(row.active_products),
      readyProducts,
      cacheProducts,
      staleProducts,
      unavailableProducts,
      listed30d,
      activeListings: toNumber(row.active_listings),
      completedQueue30d,
      failedQueue30d,
      avgProfit,
      avgRoi,
      avgScore,
      healthScore,
      learningMultiplier,
      recommendedAction: getRecommendedAction({
        readyProducts,
        cacheProducts,
        staleProducts,
        unavailableProducts,
        failedQueue30d,
        completedQueue30d,
        avgProfit,
        avgRoi,
        lastCacheAt,
      }),
      lastCacheAt,
      lastSeenAt: toIso(row.last_seen_at),
    }
  })

  for (const row of normalized) {
    await sql`
      INSERT INTO source_niche_intelligence (
        niche, active_products, ready_products, cache_products, stale_products,
        unavailable_products, listed_30d, active_listings, completed_queue_30d,
        failed_queue_30d, avg_profit, avg_roi, avg_score, health_score,
        learning_multiplier, recommended_action, last_cache_at, last_seen_at, updated_at
      )
      VALUES (
        ${row.niche}, ${row.activeProducts}, ${row.readyProducts}, ${row.cacheProducts}, ${row.staleProducts},
        ${row.unavailableProducts}, ${row.listed30d}, ${row.activeListings}, ${row.completedQueue30d},
        ${row.failedQueue30d}, ${row.avgProfit}, ${row.avgRoi}, ${row.avgScore}, ${row.healthScore},
        ${row.learningMultiplier}, ${row.recommendedAction}, ${row.lastCacheAt}, ${row.lastSeenAt}, NOW()
      )
      ON CONFLICT (niche) DO UPDATE SET
        active_products = EXCLUDED.active_products,
        ready_products = EXCLUDED.ready_products,
        cache_products = EXCLUDED.cache_products,
        stale_products = EXCLUDED.stale_products,
        unavailable_products = EXCLUDED.unavailable_products,
        listed_30d = EXCLUDED.listed_30d,
        active_listings = EXCLUDED.active_listings,
        completed_queue_30d = EXCLUDED.completed_queue_30d,
        failed_queue_30d = EXCLUDED.failed_queue_30d,
        avg_profit = EXCLUDED.avg_profit,
        avg_roi = EXCLUDED.avg_roi,
        avg_score = EXCLUDED.avg_score,
        health_score = EXCLUDED.health_score,
        learning_multiplier = EXCLUDED.learning_multiplier,
        recommended_action = EXCLUDED.recommended_action,
        last_cache_at = EXCLUDED.last_cache_at,
        last_seen_at = EXCLUDED.last_seen_at,
        updated_at = NOW()
    `.catch(() => {})
  }

  const scoredProducts = options.applyScores === false ? 0 : await applySourceIntelligenceScores()
  return {
    nichesAnalyzed: normalized.length,
    weakNiches: normalized
      .filter((row) => row.healthScore < 65 || row.readyProducts < 30 || row.cacheProducts < 30)
      .sort((a, b) => a.healthScore - b.healthScore)
      .slice(0, 8),
    scoredProducts,
  }
}

export async function applySourceIntelligenceScores(limit = 6000) {
  await ensureSourceIntelligenceTables()
  const rows = await queryRows<{ count: string | number }>`
    WITH ranked AS (
      SELECT
        psi.asin,
        ROUND((
          psi.total_score
          * COALESCE(sni.learning_multiplier, 1)
          * CASE WHEN psi.risk = 'LOW' THEN 1.07 WHEN psi.risk = 'MEDIUM' THEN 0.94 ELSE 0.68 END
          * CASE WHEN psi.image_url IS NOT NULL AND psi.image_url <> '' THEN 1.06 ELSE 0.74 END
          * CASE WHEN psi.last_seen_at > NOW() - INTERVAL '3 days' THEN 1.06
                 WHEN psi.last_seen_at > NOW() - INTERVAL '14 days' THEN 1.00
                 ELSE 0.78 END
          * CASE WHEN psi.profit >= 18 THEN 1.10 WHEN psi.profit >= 8 THEN 1.04 WHEN psi.profit >= 4 THEN 0.95 ELSE 0.70 END
          * CASE WHEN psi.roi >= 75 THEN 1.08 WHEN psi.roi >= 45 THEN 1.02 WHEN psi.roi >= 30 THEN 0.94 ELSE 0.72 END
          * CASE WHEN COALESCE(apc.available, TRUE) = FALSE THEN 0.10 ELSE 1 END
          * CASE
              WHEN apc.best_seller_rank IS NULL THEN 1.00
              WHEN apc.best_seller_rank <= 500 THEN 1.25
              WHEN apc.best_seller_rank <= 2000 THEN 1.15
              WHEN apc.best_seller_rank <= 10000 THEN 1.07
              WHEN apc.best_seller_rank <= 50000 THEN 1.00
              ELSE 0.91
            END
          * CASE
              WHEN psi.ebay_competitor_count IS NULL THEN 1.00
              WHEN psi.ebay_competitor_count <= 10 THEN 1.05
              WHEN psi.ebay_competitor_count <= 30 THEN 0.97
              WHEN psi.ebay_competitor_count <= 75 THEN 0.88
              WHEN psi.ebay_competitor_count <= 150 THEN 0.76
              ELSE 0.60
            END
          * COALESCE(LEAST(GREATEST(psi.listing_outcome_score, 0.60), 1.25), 1.00)
        )::numeric, 2) AS intelligence_score,
        CASE
          WHEN psi.active = FALSE THEN 'inactive'
          WHEN COALESCE(apc.available, TRUE) = FALSE THEN 'reject'
          WHEN psi.risk = 'HIGH' OR psi.profit < 1 OR psi.roi < 15 THEN 'reject'
          WHEN psi.image_url IS NULL OR psi.image_url = '' THEN 'needs_images'
          WHEN psi.last_seen_at < NOW() - INTERVAL '21 days' THEN 'stale'
          WHEN apc.asin IS NOT NULL
            AND apc.available = TRUE
            AND jsonb_typeof(apc.images) = 'array'
            AND jsonb_array_length(apc.images) >= 2
            AND psi.profit >= 8
            AND psi.roi >= 35
            AND psi.risk <> 'HIGH'
          THEN 'ready'
          ELSE 'candidate'
        END AS source_quality
      FROM product_source_items psi
      LEFT JOIN source_niche_intelligence sni ON sni.niche = COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned')
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      WHERE psi.active = TRUE
      ORDER BY psi.last_seen_at DESC
      LIMIT ${Math.max(100, Math.min(15000, limit))}
    ),
    updated AS (
      UPDATE product_source_items psi
      SET intelligence_score = ranked.intelligence_score,
          source_quality = ranked.source_quality,
          last_intelligence_at = NOW()
      FROM ranked
      WHERE psi.asin = ranked.asin
      RETURNING psi.asin
    )
    SELECT COUNT(*)::int AS count FROM updated
  `.catch(() => [])
  return toNumber(rows[0]?.count)
}

export async function applyListingOutcomeFeedback() {
  const rows = await queryRows<{ count: string | number }>`
    WITH outcomes AS (
      SELECT
        asin,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= 2) AS hard_failed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed
      FROM auto_listing_queue
      WHERE updated_at > NOW() - INTERVAL '60 days'
      GROUP BY asin
    ),
    updated AS (
      UPDATE product_source_items psi
      SET listing_outcome_score = LEAST(1.25, GREATEST(0.60, CASE
        WHEN o.completed > 0 AND o.hard_failed = 0 THEN 1.0 + (0.08 * LEAST(o.completed, 3))
        WHEN o.completed > 0 THEN 1.0 + (0.10 * o.completed) - (0.07 * o.hard_failed)
        WHEN o.hard_failed > 0 THEN 1.0 - (0.12 * LEAST(o.hard_failed, 3))
        ELSE 1.0
      END))
      FROM outcomes o
      WHERE psi.asin = o.asin
      RETURNING psi.asin
    )
    SELECT COUNT(*)::int AS count FROM updated
  `.catch(() => [])
  return toNumber(rows[0]?.count)
}

export async function runSourceSelfHealing(options: { applyScores?: boolean; deactivateWeak?: boolean } = {}) {
  await ensureSourceIntelligenceTables()
  const intelligence = await refreshSourceIntelligenceState({ applyScores: options.applyScores !== false })
  const deactivatedRows = options.deactivateWeak === false
    ? []
    : await queryRows<{ asin: string }>`
        UPDATE product_source_items
        SET active = FALSE,
            source_quality = 'reject',
            last_intelligence_at = NOW()
        WHERE active = TRUE
          AND (
            product_source_items.risk = 'HIGH'
            OR product_source_items.profit < 1
            OR product_source_items.roi < 15
            OR product_source_items.last_seen_at < NOW() - INTERVAL '60 days'
            OR EXISTS (
              SELECT 1
              FROM amazon_product_cache apc
              WHERE UPPER(apc.asin) = UPPER(product_source_items.asin)
                AND apc.available = FALSE
            )
          )
        RETURNING asin
      `.catch(() => [])

  const outcomeFeedbackUpdated = await applyListingOutcomeFeedback().catch(() => 0)
  const competitionEnriched = await enrichCompetitionData({ limit: 20 }).catch(() => ({ enriched: 0, failed: 0 }))
  const recommendations = await getSourceRecommendations(8)
  return {
    ...intelligence,
    deactivatedWeakProducts: deactivatedRows.length,
    outcomeFeedbackUpdated,
    competitionEnriched: competitionEnriched.enriched,
    recommendations,
  }
}

export async function getWeakSourceNiches(limit = 6) {
  await ensureSourceIntelligenceTables()
  const rows = await queryRows<{ niche: string }>`
    SELECT niche
    FROM source_niche_intelligence
    WHERE (
      ready_products < 30
       OR cache_products < 30
       OR health_score < 65
       OR last_cache_at IS NULL
       OR last_cache_at < NOW() - INTERVAL '48 hours'
    )
      AND lower(niche) NOT LIKE '%supplement%'
      AND lower(niche) NOT LIKE '%vitamin%'
      AND lower(niche) NOT LIKE '%medical%'
      AND lower(niche) NOT LIKE '%medicine%'
      AND lower(niche) NOT LIKE '%prescription%'
      AND lower(niche) NOT LIKE '%cosmetic%'
      AND lower(niche) NOT LIKE '%makeup%'
      AND lower(niche) NOT LIKE '%perfume%'
    ORDER BY
      CASE WHEN cache_products < 30 THEN 0 ELSE 1 END,
      health_score ASC,
      ready_products ASC,
      cache_products ASC,
      updated_at ASC
    LIMIT ${Math.max(1, Math.min(20, limit))}
  `.catch(() => [])
  return rows.map((row) => row.niche).filter(Boolean)
}

export async function getNicheStockRepairTargets(limit = 6) {
  await ensureSourceIntelligenceTables()
  const rows = await queryRows<{ niche: string }>`
    SELECT niche
    FROM source_niche_intelligence
    WHERE (
      ready_products < 30
       OR cache_products < 30
       OR last_cache_at IS NULL
       OR last_cache_at < NOW() - INTERVAL '36 hours'
    )
      AND lower(niche) NOT LIKE '%supplement%'
      AND lower(niche) NOT LIKE '%vitamin%'
      AND lower(niche) NOT LIKE '%medical%'
      AND lower(niche) NOT LIKE '%medicine%'
      AND lower(niche) NOT LIKE '%prescription%'
      AND lower(niche) NOT LIKE '%cosmetic%'
      AND lower(niche) NOT LIKE '%makeup%'
      AND lower(niche) NOT LIKE '%perfume%'
    ORDER BY
      CASE WHEN ready_products < 30 THEN 0 ELSE 1 END,
      CASE WHEN cache_products < 30 THEN 0 ELSE 1 END,
      ready_products ASC,
      cache_products ASC,
      last_cache_at ASC NULLS FIRST,
      health_score ASC,
      updated_at ASC
    LIMIT ${Math.max(1, Math.min(20, limit))}
  `.catch(() => [])
  return rows.map((row) => row.niche).filter(Boolean)
}

export async function getSourceRecommendations(limit = 8) {
  await ensureSourceIntelligenceTables()
  const rows = await queryRows<SourceRecommendationRow>`
    SELECT
      niche,
      active_products,
      ready_products,
      cache_products,
      stale_products,
      unavailable_products,
      failed_queue_30d,
      completed_queue_30d,
      avg_profit,
      avg_roi,
      health_score,
      learning_multiplier,
      recommended_action,
      last_cache_at,
      updated_at
    FROM source_niche_intelligence
    ORDER BY health_score ASC, ready_products ASC, cache_products ASC
    LIMIT ${Math.max(1, Math.min(20, limit))}
  `.catch(() => [])

  return rows.map((row) => ({
    niche: row.niche,
    healthScore: toNumber(row.health_score),
    readyProducts: toNumber(row.ready_products),
    cacheProducts: toNumber(row.cache_products),
    activeProducts: toNumber(row.active_products),
    staleProducts: toNumber(row.stale_products),
    unavailableProducts: toNumber(row.unavailable_products),
    failedQueue30d: toNumber(row.failed_queue_30d),
    completedQueue30d: toNumber(row.completed_queue_30d),
    averageProfit: toNumber(row.avg_profit),
    averageRoi: toNumber(row.avg_roi),
    learningMultiplier: toNumber(row.learning_multiplier),
    recommendedAction: row.recommended_action || 'Review this niche.',
    lastCacheAt: toIso(row.last_cache_at),
    updatedAt: toIso(row.updated_at),
  }))
}

export async function getSourceEngineIntelligenceSummary() {
  await ensureSourceIntelligenceTables()
  const [runRows, todayRows, readyRows, failedRows, recommendations, autopilot] = await Promise.all([
    queryRows<SourceRunRow>`
      SELECT id, mode, trigger, status, products_found, products_rejected, ready_to_list, duration_ms, created_at, error
      FROM source_engine_runs
      ORDER BY created_at DESC
      LIMIT 8
    `.catch(() => []),
    queryRows<{
      new_products: string | number
      pool_snapshots: string | number
      products_rejected: string | number
      runs: string | number
    }>`
      SELECT
        COALESCE((
          SELECT COUNT(*)
          FROM product_source_items
          WHERE first_seen_at >= date_trunc('day', NOW())
        ), 0)::int AS new_products,
        COALESCE(SUM(products_found), 0)::int AS pool_snapshots,
        COALESCE(SUM(products_rejected), 0)::int AS products_rejected,
        COUNT(*)::int AS runs
      FROM source_engine_runs
      WHERE created_at >= date_trunc('day', NOW())
    `.catch(() => []),
    queryRows<{ ready_to_list: string | number; weak_niches: string | number; avg_health: string | number | null }>`
      SELECT
        COALESCE(SUM(ready_products), 0)::int AS ready_to_list,
        COUNT(*) FILTER (WHERE ready_products < 30 OR cache_products < 30 OR health_score < 65)::int AS weak_niches,
        ROUND(AVG(health_score), 2) AS avg_health
      FROM source_niche_intelligence
    `.catch(() => []),
    queryRows<{ failed_jobs: string | number }>`
      SELECT COUNT(*)::int AS failed_jobs
      FROM source_engine_runs
      WHERE status <> 'success'
        AND created_at > NOW() - INTERVAL '24 hours'
    `.catch(() => []),
    getSourceRecommendations(8),
    getSourceAutopilotStatus(),
  ])

  const latestRun = runRows[0] || null
  return {
    status: toNumber(failedRows[0]?.failed_jobs) > 0 ? 'watch' : toNumber(readyRows[0]?.weak_niches) > 0 ? 'self-healing' : 'healthy',
    lastRun: latestRun ? {
      id: String(latestRun.id),
      mode: latestRun.mode,
      trigger: latestRun.trigger,
      status: latestRun.status,
      productsFound: toNumber(latestRun.products_found),
      productsRejected: toNumber(latestRun.products_rejected),
      readyToList: toNumber(latestRun.ready_to_list),
      durationMs: toNumber(latestRun.duration_ms),
      createdAt: toIso(latestRun.created_at),
      error: latestRun.error,
    } : null,
    runsToday: toNumber(todayRows[0]?.runs),
    productsFoundToday: toNumber(todayRows[0]?.new_products),
    productsRejectedToday: toNumber(todayRows[0]?.products_rejected),
    readyToListProducts: toNumber(readyRows[0]?.ready_to_list),
    weakNiches: toNumber(readyRows[0]?.weak_niches),
    averageNicheHealth: toNumber(readyRows[0]?.avg_health),
    failedJobs24h: toNumber(failedRows[0]?.failed_jobs),
    autopilot,
    recentRuns: runRows.map((row) => ({
      id: String(row.id),
      mode: row.mode,
      trigger: row.trigger,
      status: row.status,
      productsFound: toNumber(row.products_found),
      productsRejected: toNumber(row.products_rejected),
      readyToList: toNumber(row.ready_to_list),
      durationMs: toNumber(row.duration_ms),
      createdAt: toIso(row.created_at),
      error: row.error,
    })),
    recommendations,
  }
}

export async function getSourceAutopilotStatus() {
  await ensureSourceIntelligenceTables()
  const rows = await queryRows<SourceAutopilotLockRow>`
    SELECT name, locked_until, last_started_at, last_reason, last_niches, updated_at
    FROM source_autopilot_locks
    WHERE name = 'source-repair'
    LIMIT 1
  `.catch(() => [])

  const row = rows[0]
  const lockedUntil = toIso(row?.locked_until)
  const lockedUntilDate = lockedUntil ? new Date(lockedUntil) : null
  const available = !lockedUntilDate || Number.isNaN(lockedUntilDate.getTime()) || lockedUntilDate.getTime() <= Date.now()

  return {
    enabled: true,
    available,
    nextRunAfter: lockedUntil,
    lastStartedAt: toIso(row?.last_started_at),
    lastReason: row?.last_reason || null,
    lastNiches: parseStringArray(row?.last_niches),
    updatedAt: toIso(row?.updated_at),
  }
}

export async function reserveSourceAutopilotRun(input: {
  reason: string
  niches?: string[]
  cooldownMinutes?: number
}) {
  await ensureSourceIntelligenceTables()
  const cooldownMinutes = Math.max(20, Math.min(240, Math.round(input.cooldownMinutes || 75)))
  const niches = Array.from(new Set((input.niches || []).map((niche) => niche.trim()).filter(Boolean))).slice(0, 3)
  const reason = input.reason.slice(0, 240)
  const rows = await queryRows<SourceAutopilotLockRow>`
    INSERT INTO source_autopilot_locks (
      name, locked_until, last_started_at, last_reason, last_niches, updated_at
    )
    VALUES (
      'source-repair',
      NOW() + (${cooldownMinutes} * INTERVAL '1 minute'),
      NOW(),
      ${reason},
      ${JSON.stringify(niches)}::jsonb,
      NOW()
    )
    ON CONFLICT (name) DO UPDATE SET
      locked_until = EXCLUDED.locked_until,
      last_started_at = EXCLUDED.last_started_at,
      last_reason = EXCLUDED.last_reason,
      last_niches = EXCLUDED.last_niches,
      updated_at = NOW()
    WHERE source_autopilot_locks.locked_until <= NOW()
    RETURNING name, locked_until, last_started_at, last_reason, last_niches, updated_at
  `.catch(() => [])

  const reserved = Boolean(rows[0])
  const status = reserved ? rows[0] : (await queryRows<SourceAutopilotLockRow>`
    SELECT name, locked_until, last_started_at, last_reason, last_niches, updated_at
    FROM source_autopilot_locks
    WHERE name = 'source-repair'
    LIMIT 1
  `.catch(() => []))[0]

  return {
    reserved,
    reason: status?.last_reason || reason,
    niches: parseStringArray(status?.last_niches),
    nextRunAfter: toIso(status?.locked_until),
    lastStartedAt: toIso(status?.last_started_at),
    updatedAt: toIso(status?.updated_at),
  }
}

export async function recordSourceEngineRun(input: SourceEngineRunInput) {
  await ensureSourceIntelligenceTables()
  const metrics = input.metrics || {}
  const productsFound =
    toNumber(metrics.sourceProducts) ||
    toNumber(metrics.continuousProducts) ||
    toNumber(metrics.productsFound)
  const productsRejected =
    toNumber(metrics.deactivatedUnavailableSources) +
    toNumber(metrics.deactivatedWeakProducts) +
    toNumber((metrics.priceRefresh as { failed?: unknown } | undefined)?.failed)
  const readyToList =
    toNumber((metrics.sourceIntelligence as { readyToListProducts?: unknown } | undefined)?.readyToListProducts) ||
    toNumber(metrics.continuousProducts)
  const staleProducts = toNumber((metrics.sourceIntelligence as { staleProducts?: unknown } | undefined)?.staleProducts)
  const durationMs = Math.max(0, Math.round(Date.now() - input.startedAt))

  await sql`
    INSERT INTO source_engine_runs (
      mode, trigger, status, niches, products_found, products_rejected,
      ready_to_list, stale_products, duration_ms, metrics, recommendations, error
    )
    VALUES (
      ${input.mode},
      ${input.trigger},
      ${input.status},
      ${JSON.stringify(input.niches || [])}::jsonb,
      ${productsFound},
      ${productsRejected},
      ${readyToList},
      ${staleProducts},
      ${durationMs},
      ${JSON.stringify(metrics)}::jsonb,
      ${JSON.stringify(input.recommendations || [])}::jsonb,
      ${input.error || null}
    )
  `.catch(() => {})
}
