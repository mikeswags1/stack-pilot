import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows } from '@/lib/db'
import { ensureProductSourceTables } from '@/lib/product-source-engine'
import { isRapidApiFallbackEnabled } from '@/lib/rapidapi'
import { isWeakListingTitle } from '@/lib/listing-quality'
import { getSourceEngineIntelligenceSummary, refreshSourceIntelligenceState } from '@/lib/source-intelligence'

type SourceSummaryRow = {
  total?: number | string
  niches?: number | string
  stale?: number | string
  missing_images?: number | string
  high_risk?: number | string
  avg_score?: number | string | null
  newest_seen?: string | null
}

type NicheRow = {
  name?: string | null
  count?: number | string
  avg_score?: number | string | null
  max_score?: number | string | null
  newest_seen?: string | null
}

type NicheCatalogRow = {
  name?: string | null
  active_products?: number | string
  publish_ready?: number | string
  needs_enrichment?: number | string
  cache_products?: number | string
  avg_score?: number | string | null
  newest_seen?: string | null
}

type NicheSourceRow = {
  name?: string | null
  title?: string | null
  image_url?: string | null
  risk?: string | null
  total_score?: number | string | null
  last_seen_at?: string | null
}

type CacheSummaryRow = {
  total_niches?: number | string
  ready_niches?: number | string
  stale_niches?: number | string
  total_products?: number | string
}

type ContinuousRow = {
  count?: number | string
  version?: number | string
  cached_at?: string | null
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

function buildReadyNicheRows(rows: NicheSourceRow[]): NicheRow[] {
  const groups = new Map<string, { count: number; score: number; maxScore: number; newest: string | null }>()

  for (const row of rows) {
    const title = row.title || ''
    if (!title || isWeakListingTitle(title)) continue
    if (!row.image_url) continue
    if (row.risk === 'HIGH') continue

    const name = row.name || 'Unassigned'
    const score = toNumber(row.total_score)
    const current = groups.get(name) || { count: 0, score: 0, maxScore: 0, newest: null }
    current.count += 1
    current.score += score
    current.maxScore = Math.max(current.maxScore, score)
    if (!current.newest || Date.parse(String(row.last_seen_at || '')) > Date.parse(current.newest)) {
      current.newest = row.last_seen_at || current.newest
    }
    groups.set(name, current)
  }

  return Array.from(groups.entries())
    .map(([name, group]) => ({
      name,
      count: group.count,
      avg_score: group.count > 0 ? Number((group.score / group.count).toFixed(2)) : 0,
      max_score: Number(group.maxScore.toFixed(2)),
      newest_seen: group.newest,
    }))
    .sort((a, b) => toNumber(b.count) - toNumber(a.count) || toNumber(b.avg_score) - toNumber(a.avg_score))
    .slice(0, 12)
}

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  await Promise.all([
    ensureProductSourceTables().catch(() => {}),
    refreshSourceIntelligenceState({ applyScores: false }).catch(() => null),
  ])

  const [sourceRows, sourceIntelligence] = await Promise.all([
    queryRows<SourceSummaryRow>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(DISTINCT source_niche)::int AS niches,
      COUNT(*) FILTER (WHERE last_seen_at < NOW() - INTERVAL '7 days')::int AS stale,
      COUNT(*) FILTER (WHERE image_url IS NULL OR image_url = '')::int AS missing_images,
      COUNT(*) FILTER (WHERE risk = 'HIGH')::int AS high_risk,
      ROUND(AVG(total_score), 2) AS avg_score,
      MAX(last_seen_at) AS newest_seen
    FROM product_source_items
    WHERE active = TRUE
    `.catch(() => []),
    getSourceEngineIntelligenceSummary().catch(() => null),
  ])

  const [nicheSourceRows, nicheCatalogRows] = await Promise.all([
    queryRows<NicheSourceRow>`
    SELECT
      COALESCE(source_niche, 'Unassigned') AS name,
      title,
      image_url,
      risk,
      total_score,
      last_seen_at
    FROM product_source_items
    WHERE active = TRUE
      AND last_seen_at > NOW() - INTERVAL '21 days'
    `.catch(() => []),
    queryRows<NicheCatalogRow>`
      WITH source AS (
        SELECT
          COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned') AS name,
          COUNT(*) FILTER (WHERE psi.active = TRUE)::int AS active_products,
          ROUND(AVG(psi.total_score) FILTER (WHERE psi.active = TRUE), 2) AS avg_score,
          MAX(psi.last_seen_at) FILTER (WHERE psi.active = TRUE) AS newest_seen,
          COUNT(*) FILTER (
            WHERE psi.active = TRUE
              AND psi.profit >= 4
              AND psi.roi >= 25
              AND psi.risk <> 'HIGH'
              AND psi.image_url IS NOT NULL
              AND psi.image_url <> ''
              AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
              AND COALESCE(apc.available, TRUE) <> FALSE
              AND apc.asin IS NOT NULL
              AND jsonb_typeof(apc.images) = 'array'
              AND jsonb_array_length(apc.images) >= 2
              AND NOT EXISTS (
                SELECT 1 FROM listed_asins la
                WHERE UPPER(la.asin) = UPPER(psi.asin)
                  AND la.ended_at IS NULL
              )
          )::int AS publish_ready,
          COUNT(*) FILTER (
            WHERE psi.active = TRUE
              AND psi.profit >= 4
              AND psi.roi >= 25
              AND psi.risk <> 'HIGH'
              AND psi.image_url IS NOT NULL
              AND psi.image_url <> ''
              AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
              AND COALESCE(apc.available, TRUE) <> FALSE
              AND NOT (
                apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
              )
              AND NOT EXISTS (
                SELECT 1 FROM listed_asins la
                WHERE UPPER(la.asin) = UPPER(psi.asin)
                  AND la.ended_at IS NULL
              )
          )::int AS needs_enrichment
        FROM product_source_items psi
        LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
        GROUP BY COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned')
      ),
      cache AS (
        SELECT
          niche AS name,
          CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) ELSE 0 END AS cache_products
        FROM product_cache
        WHERE niche NOT IN ('__continuous_listing__', '__cursor__')
      )
      SELECT
        COALESCE(source.name, cache.name) AS name,
        COALESCE(source.active_products, 0)::int AS active_products,
        COALESCE(source.publish_ready, 0)::int AS publish_ready,
        COALESCE(source.needs_enrichment, 0)::int AS needs_enrichment,
        COALESCE(cache.cache_products, 0)::int AS cache_products,
        COALESCE(source.avg_score, 0) AS avg_score,
        source.newest_seen
      FROM source
      FULL JOIN cache ON cache.name = source.name
      WHERE COALESCE(source.name, cache.name) IS NOT NULL
        AND COALESCE(source.name, cache.name) <> 'Unassigned'
      ORDER BY
        COALESCE(source.publish_ready, 0) DESC,
        COALESCE(source.active_products, 0) DESC,
        COALESCE(source.avg_score, 0) DESC
    `.catch(() => []),
  ])
  const nicheRows = buildReadyNicheRows(nicheSourceRows)

  const cacheRows = await queryRows<CacheSummaryRow>`
    SELECT
      COUNT(*) FILTER (WHERE niche <> '__continuous_listing__')::int AS total_niches,
      COUNT(*) FILTER (WHERE niche <> '__continuous_listing__' AND jsonb_array_length(results) >= 30)::int AS ready_niches,
      COUNT(*) FILTER (WHERE niche <> '__continuous_listing__' AND cached_at < NOW() - INTERVAL '24 hours')::int AS stale_niches,
      COALESCE(SUM(jsonb_array_length(results)) FILTER (WHERE niche <> '__continuous_listing__'), 0)::int AS total_products
    FROM product_cache
  `.catch(() => [])

  const continuousRows = await queryRows<ContinuousRow>`
    SELECT jsonb_array_length(results)::int AS count, version, cached_at
    FROM product_cache
    WHERE niche = '__continuous_listing__'
  `.catch(() => [])

  const source = sourceRows[0] || {}
  const cache = cacheRows[0] || {}
  const continuous = continuousRows[0] || {}
  const sourceTotal = toNumber(source.total)
  const readyNiches = toNumber(cache.ready_niches)
  const totalNiches = toNumber(cache.total_niches)
  const continuousCount = toNumber(continuous.count)

  const warnings: string[] = []
  if (sourceTotal < 5000) warnings.push('Source engine pool is below the public-launch target of 5,000 products.')
  if (continuousCount < 90) warnings.push('Continuous Listing pool has fewer than 90 products ready.')
  if (totalNiches > 0 && readyNiches < Math.max(1, Math.floor(totalNiches * 0.7))) warnings.push('Several niche caches are below 30 products.')
  if (toNumber(source.stale) > sourceTotal * 0.45) warnings.push('A large share of source products are older than 7 days.')
  if (toNumber(source.missing_images) > sourceTotal * 0.1) warnings.push('More than 10% of source products are missing images.')

  const status = warnings.length === 0 ? 'healthy' : warnings.length <= 2 ? 'watch' : 'attention'

  return apiOk({
    generatedAt: new Date().toISOString(),
    status,
    warnings,
    sourceEngine: {
      totalProducts: sourceTotal,
      niches: toNumber(source.niches),
      staleProducts: toNumber(source.stale),
      missingImages: toNumber(source.missing_images),
      highRiskProducts: toNumber(source.high_risk),
      averageScore: toNumber(source.avg_score),
      newestSeenAt: toIso(source.newest_seen),
    },
    cache: {
      totalNiches,
      readyNiches,
      staleNiches: toNumber(cache.stale_niches),
      totalProducts: toNumber(cache.total_products),
    },
    continuous: {
      products: continuousCount,
      version: toNumber(continuous.version),
      cachedAt: toIso(continuous.cached_at),
    },
    intelligence: sourceIntelligence,
    topNiches: nicheRows.map((row) => ({
      name: row.name || 'Unassigned',
      count: toNumber(row.count),
      averageScore: toNumber(row.avg_score),
      maxScore: toNumber(row.max_score),
      newestSeenAt: toIso(row.newest_seen),
    })),
    allNiches: nicheCatalogRows.map((row) => {
      const publishReady = toNumber(row.publish_ready)
      const status: 'ready' | 'thin' | 'repairing' = publishReady >= 45 ? 'ready' : publishReady >= 30 ? 'thin' : 'repairing'
      return {
        name: row.name || 'Unassigned',
        activeProducts: toNumber(row.active_products),
        publishReady,
        needsEnrichment: toNumber(row.needs_enrichment),
        cacheProducts: toNumber(row.cache_products),
        averageScore: toNumber(row.avg_score),
        status,
        newestSeenAt: toIso(row.newest_seen),
      }
    }),
    providers: {
      rapidApiConfigured: isRapidApiFallbackEnabled(),
      liveProviderChecks: 'manual-only',
    },
  })
}
