import { after, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows } from '@/lib/db'
import { ensureAutoListingTables } from '@/lib/auto-listing/db'
import { ensureListedAsinsFinancialColumns } from '@/lib/listed-asins'
import { EBAY_DEFAULT_FEE_RATE } from '@/lib/listing-pricing'
import { ensureProductSourceTables } from '@/lib/product-source-engine'
import { getSourceEngineIntelligenceSummary, refreshSourceIntelligenceState, reserveSourceAutopilotRun } from '@/lib/source-intelligence'
import { getRecentSourceAgentRuns } from '@/lib/source-agent'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

type UserRow = {
  id: number
  email: string
  name: string | null
  created_at: string
}

type EbayRow = {
  user_id: number
  updated_at: string | null
  token_expires_at: string | null
  connected: boolean | null
}

type UserListingRow = {
  user_id: number
  total_listings: string | number
  active_listings: string | number
  last_listing_at: string | null
  active_profit: string | number | null
}

type ListingSummaryRow = {
  total_listings: string | number
  active_listings: string | number
  listed_7: string | number
  listed_30: string | number
  low_image_active: string | number
  legacy_unaudited: string | number
  one_image_active: string | number
  two_image_active: string | number
  three_plus_image_active: string | number
  image_quality_warnings: string | number
  missing_category_active: string | number
  active_revenue: string | number | null
  active_cost: string | number | null
  active_profit: string | number | null
  average_roi: string | number | null
}

type RecentListingRow = {
  id: number
  user_id: number
  seller_name: string | null
  seller_email: string
  asin: string | null
  title: string | null
  ebay_listing_id: string | null
  listed_at: string | null
  amazon_price: string | number | null
  ebay_price: string | number | null
  niche: string | null
  category_id: string | null
  image_count: string | number | null
}

type ProblemListingRow = RecentListingRow & {
  category_name: string | null
  cache_image_count: string | number | null
  cache_updated_at: string | null
  cache_available: boolean | null
}

type NichePerformanceRow = {
  niche: string | null
  listings: string | number
  sellers: string | number
  revenue: string | number | null
  profit: string | number | null
}

type SourceSummaryRow = {
  total?: number | string
  niches?: number | string
  stale?: number | string
  missing_images?: number | string
  high_risk?: number | string
  avg_score?: number | string | null
  newest_seen?: string | null
}

type SourceNicheRow = {
  name?: string | null
  count?: number | string
  avg_score?: number | string | null
  max_score?: number | string | null
  newest_seen?: string | null
}

type TrendingNicheRow = {
  name?: string | null
  active_products?: number | string
  avg_profit?: number | string | null
  avg_roi?: number | string | null
  avg_score?: number | string | null
  latest_seen?: string | null
  cache_products?: number | string | null
  cache_refreshed_at?: string | null
  missing_images?: number | string | null
  high_risk?: number | string | null
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

type AutoListingSettingsSummaryRow = {
  total_settings?: number | string
  enabled_users?: number | string
  running_users?: number | string
  paused_users?: number | string
  emergency_stopped_users?: number | string
}

type AutoListingQueueSummaryRow = {
  queued?: number | string
  retry?: number | string
  processing?: number | string
  failed?: number | string
  due_now?: number | string
  listed_24h?: number | string
  avg_score?: number | string | null
  oldest_due_at?: string | null
  next_due_at?: string | null
  latest_listed_at?: string | null
}

type ListingAvailabilitySummaryRow = {
  active_listings?: number | string
  marked_unavailable?: number | string
  due_for_audit?: number | string
  checked_24h?: number | string
  last_checked_at?: string | null
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

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  await Promise.all([
    ensureListedAsinsFinancialColumns().catch(() => {}),
    ensureAutoListingTables().catch(() => {}),
    ensureProductSourceTables().catch(() => {}),
    refreshSourceIntelligenceState({ applyScores: false }).catch(() => null),
  ])

  const [
    users,
    ebayRows,
    listingRows,
    listingSummaryRows,
    recentListingRows,
    problemListingRows,
    nichePerformanceRows,
    sourceRows,
    sourceNicheRows,
    trendingNicheRows,
    cacheRows,
    continuousRows,
    autoListingSettingsSummaryRows,
    autoListingQueueSummaryRows,
    listingAvailabilitySummaryRows,
    sourceIntelligenceSummary,
    sourceAgentRuns,
    agentStatusRows,
  ] = await Promise.all([
    queryRows<UserRow>`
      SELECT id, email, name, created_at FROM users ORDER BY created_at DESC
    `.catch(() => []),
    queryRows<EbayRow>`
      SELECT
        user_id,
        updated_at,
        token_expires_at,
        (oauth_token IS NOT NULL OR refresh_token IS NOT NULL) AS connected
      FROM ebay_credentials
    `.catch(() => []),
    queryRows<UserListingRow>`
      SELECT
        user_id,
        COUNT(*)::int AS total_listings,
        COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS active_listings,
        MAX(listed_at) AS last_listing_at,
        COALESCE(SUM(
          CASE
            WHEN ended_at IS NULL AND ebay_price IS NOT NULL AND amazon_price IS NOT NULL
            THEN ebay_price - amazon_price - (ebay_price * COALESCE(ebay_fee_rate, ${EBAY_DEFAULT_FEE_RATE})) - 0.30
            ELSE 0
          END
        ), 0) AS active_profit
      FROM listed_asins
      GROUP BY user_id
    `.catch(() => []),
    queryRows<ListingSummaryRow>`
      SELECT
        COUNT(*)::int AS total_listings,
        COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS active_listings,
        COUNT(*) FILTER (WHERE listed_at > NOW() - INTERVAL '7 days')::int AS listed_7,
        COUNT(*) FILTER (WHERE listed_at > NOW() - INTERVAL '30 days')::int AS listed_30,
        COUNT(*) FILTER (
          WHERE ended_at IS NULL
            AND image_count IS NOT NULL
            AND image_count < 2
        )::int AS low_image_active,
        COUNT(*) FILTER (
          WHERE ended_at IS NULL
            AND image_count IS NULL
            AND ebay_listing_id IS NOT NULL
            AND ebay_listing_id <> ''
        )::int AS legacy_unaudited,
        COUNT(*) FILTER (WHERE ended_at IS NULL AND image_count = 1)::int AS one_image_active,
        COUNT(*) FILTER (WHERE ended_at IS NULL AND image_count = 2)::int AS two_image_active,
        COUNT(*) FILTER (WHERE ended_at IS NULL AND image_count >= 3)::int AS three_plus_image_active,
        COUNT(*) FILTER (WHERE ended_at IS NULL AND image_quality_warning = TRUE)::int AS image_quality_warnings,
        COUNT(*) FILTER (WHERE ended_at IS NULL AND (category_id IS NULL OR category_id = ''))::int AS missing_category_active,
        COALESCE(SUM(CASE WHEN ended_at IS NULL THEN ebay_price ELSE 0 END), 0) AS active_revenue,
        COALESCE(SUM(CASE WHEN ended_at IS NULL THEN amazon_price ELSE 0 END), 0) AS active_cost,
        COALESCE(SUM(
          CASE
            WHEN ended_at IS NULL AND ebay_price IS NOT NULL AND amazon_price IS NOT NULL
            THEN ebay_price - amazon_price - (ebay_price * COALESCE(ebay_fee_rate, ${EBAY_DEFAULT_FEE_RATE})) - 0.30
            ELSE 0
          END
        ), 0) AS active_profit,
        AVG(
          CASE
            WHEN ended_at IS NULL AND amazon_price > 0 AND ebay_price IS NOT NULL
            THEN ((ebay_price - amazon_price - (ebay_price * COALESCE(ebay_fee_rate, ${EBAY_DEFAULT_FEE_RATE})) - 0.30) / amazon_price) * 100
            ELSE NULL
          END
        ) AS average_roi
      FROM listed_asins
    `.catch(() => []),
    queryRows<RecentListingRow>`
      SELECT
        la.id,
        la.user_id,
        u.name AS seller_name,
        u.email AS seller_email,
        la.asin,
        la.title,
        la.ebay_listing_id,
        la.listed_at,
        la.amazon_price,
        la.ebay_price,
        la.niche,
        la.category_id,
        CASE
          WHEN la.amazon_images IS NULL OR jsonb_typeof(la.amazon_images) <> 'array' THEN 0
          ELSE jsonb_array_length(la.amazon_images)
        END AS image_count
      FROM listed_asins la
      JOIN users u ON u.id = la.user_id
      ORDER BY la.listed_at DESC
      LIMIT 12
    `.catch(() => []),
    queryRows<ProblemListingRow>`
      SELECT
        la.id,
        la.user_id,
        u.name AS seller_name,
        u.email AS seller_email,
        la.asin,
        la.title,
        la.ebay_listing_id,
        la.listed_at,
        la.amazon_price,
        la.ebay_price,
        la.niche,
        la.category_id,
        la.category_name,
        CASE
          WHEN la.amazon_images IS NULL OR jsonb_typeof(la.amazon_images) <> 'array' THEN 0
          ELSE jsonb_array_length(la.amazon_images)
        END AS image_count,
        CASE
          WHEN apc.images IS NULL OR jsonb_typeof(apc.images) <> 'array' THEN 0
          ELSE jsonb_array_length(apc.images)
        END AS cache_image_count,
        apc.updated_at AS cache_updated_at,
        apc.available AS cache_available
      FROM listed_asins la
      JOIN users u ON u.id = la.user_id
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(la.asin)
      WHERE la.ended_at IS NULL
        AND (
          la.category_id IS NULL
          OR la.category_id = ''
          OR la.amazon_images IS NULL
          OR jsonb_typeof(la.amazon_images) <> 'array'
          OR jsonb_array_length(la.amazon_images) < 2
        )
      ORDER BY
        CASE
          WHEN la.category_id IS NULL OR la.category_id = '' THEN 0
          ELSE 1
        END,
        CASE
          WHEN la.amazon_images IS NULL OR jsonb_typeof(la.amazon_images) <> 'array' OR jsonb_array_length(la.amazon_images) < 2 THEN 0
          ELSE 1
        END,
        la.listed_at DESC NULLS LAST
      LIMIT 100
    `.catch(() => []),
    queryRows<NichePerformanceRow>`
      SELECT
        COALESCE(NULLIF(niche, ''), 'Unassigned') AS niche,
        COUNT(*)::int AS listings,
        COUNT(DISTINCT user_id)::int AS sellers,
        COALESCE(SUM(ebay_price), 0) AS revenue,
        COALESCE(SUM(
          CASE
            WHEN ebay_price IS NOT NULL AND amazon_price IS NOT NULL
            THEN ebay_price - amazon_price - (ebay_price * COALESCE(ebay_fee_rate, ${EBAY_DEFAULT_FEE_RATE})) - 0.30
            ELSE 0
          END
        ), 0) AS profit
      FROM listed_asins
      WHERE listed_at > NOW() - INTERVAL '90 days'
      GROUP BY COALESCE(NULLIF(niche, ''), 'Unassigned')
      ORDER BY profit DESC, listings DESC
      LIMIT 10
    `.catch(() => []),
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
    queryRows<SourceNicheRow>`
      SELECT
        COALESCE(source_niche, 'Unassigned') AS name,
        COUNT(*)::int AS count,
        ROUND(AVG(total_score), 2) AS avg_score,
        ROUND(MAX(total_score), 2) AS max_score,
        MAX(last_seen_at) AS newest_seen
      FROM product_source_items
      WHERE active = TRUE
      GROUP BY COALESCE(source_niche, 'Unassigned')
      ORDER BY count DESC, avg_score DESC
      LIMIT 12
    `.catch(() => []),
    queryRows<TrendingNicheRow>`
      WITH source AS (
        SELECT
          COALESCE(NULLIF(source_niche, ''), 'Unassigned') AS name,
          COUNT(*) FILTER (WHERE active = TRUE)::int AS active_products,
          ROUND(AVG(profit) FILTER (WHERE active = TRUE), 2) AS avg_profit,
          ROUND(AVG(roi) FILTER (WHERE active = TRUE), 2) AS avg_roi,
          ROUND(AVG(total_score) FILTER (WHERE active = TRUE), 2) AS avg_score,
          MAX(last_seen_at) FILTER (WHERE active = TRUE) AS latest_seen,
          COUNT(*) FILTER (WHERE active = TRUE AND (image_url IS NULL OR image_url = ''))::int AS missing_images,
          COUNT(*) FILTER (WHERE active = TRUE AND risk = 'HIGH')::int AS high_risk
        FROM product_source_items
        GROUP BY COALESCE(NULLIF(source_niche, ''), 'Unassigned')
      ),
      cache AS (
        SELECT
          niche AS name,
          CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) ELSE 0 END AS cache_products,
          cached_at AS cache_refreshed_at
        FROM product_cache
        WHERE niche NOT IN ('__continuous_listing__', '__cursor__')
      )
      SELECT
        COALESCE(source.name, cache.name) AS name,
        COALESCE(source.active_products, 0)::int AS active_products,
        source.avg_profit,
        source.avg_roi,
        source.avg_score,
        source.latest_seen,
        COALESCE(cache.cache_products, 0)::int AS cache_products,
        cache.cache_refreshed_at,
        COALESCE(source.missing_images, 0)::int AS missing_images,
        COALESCE(source.high_risk, 0)::int AS high_risk
      FROM source
      FULL JOIN cache ON cache.name = source.name
      WHERE COALESCE(source.name, cache.name) IS NOT NULL
        AND COALESCE(source.name, cache.name) <> 'Unassigned'
      ORDER BY COALESCE(source.active_products, 0) DESC, COALESCE(source.avg_score, 0) DESC
      LIMIT 80
    `.catch(() => []),
    queryRows<CacheSummaryRow>`
      SELECT
        COUNT(*) FILTER (
          WHERE niche NOT IN ('__continuous_listing__', '__cursor__')
            AND jsonb_typeof(results) = 'array'
        )::int AS total_niches,
        COUNT(*) FILTER (
          WHERE niche NOT IN ('__continuous_listing__', '__cursor__')
            AND jsonb_typeof(results) = 'array'
            AND jsonb_array_length(results) >= 30
        )::int AS ready_niches,
        COUNT(*) FILTER (
          WHERE niche NOT IN ('__continuous_listing__', '__cursor__')
            AND jsonb_typeof(results) = 'array'
            AND cached_at < NOW() - INTERVAL '24 hours'
        )::int AS stale_niches,
        COALESCE(SUM(
          CASE
            WHEN niche NOT IN ('__continuous_listing__', '__cursor__')
              AND jsonb_typeof(results) = 'array'
            THEN jsonb_array_length(results)
            ELSE 0
          END
        ), 0)::int AS total_products
      FROM product_cache
    `.catch(() => []),
    queryRows<ContinuousRow>`
      SELECT jsonb_array_length(results)::int AS count, version, cached_at
      FROM product_cache
      WHERE niche = '__continuous_listing__'
    `.catch(() => []),
    queryRows<AutoListingSettingsSummaryRow>`
      SELECT
        COUNT(*)::int AS total_settings,
        COUNT(*) FILTER (WHERE enabled = TRUE)::int AS enabled_users,
        COUNT(*) FILTER (WHERE enabled = TRUE AND paused = FALSE AND emergency_stopped = FALSE)::int AS running_users,
        COUNT(*) FILTER (WHERE paused = TRUE)::int AS paused_users,
        COUNT(*) FILTER (WHERE emergency_stopped = TRUE)::int AS emergency_stopped_users
      FROM auto_listing_settings
    `.catch(() => []),
    queryRows<AutoListingQueueSummaryRow>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE status = 'retry')::int AS retry,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (
          WHERE status IN ('queued', 'retry')
            AND (scheduled_at IS NULL OR scheduled_at <= NOW())
        )::int AS due_now,
        COUNT(*) FILTER (
          WHERE status = 'completed'
            AND listed_at >= NOW() - INTERVAL '24 hours'
        )::int AS listed_24h,
        ROUND(AVG(score) FILTER (WHERE status IN ('queued', 'retry')), 2) AS avg_score,
        MIN(scheduled_at) FILTER (WHERE status IN ('queued', 'retry')) AS oldest_due_at,
        MIN(scheduled_at) FILTER (
          WHERE status IN ('queued', 'retry')
            AND scheduled_at > NOW()
        ) AS next_due_at,
        MAX(listed_at) FILTER (WHERE status = 'completed') AS latest_listed_at
      FROM auto_listing_queue
    `.catch(() => []),
    queryRows<ListingAvailabilitySummaryRow>`
      SELECT
        COUNT(*)::int AS active_listings,
        COUNT(*) FILTER (WHERE amazon_available = FALSE)::int AS marked_unavailable,
        COUNT(*) FILTER (
          WHERE amazon_status_checked_at IS NULL
            OR amazon_status_checked_at < NOW() - INTERVAL '24 hours'
        )::int AS due_for_audit,
        COUNT(*) FILTER (
          WHERE amazon_status_checked_at >= NOW() - INTERVAL '24 hours'
        )::int AS checked_24h,
        MAX(amazon_status_checked_at) AS last_checked_at
      FROM listed_asins
      WHERE ended_at IS NULL
    `.catch(() => []),
    getSourceEngineIntelligenceSummary().catch(() => null),
    getRecentSourceAgentRuns(5).catch(() => []),
    // Agent last-run times for 24/7 status dashboard
    queryRows<{ agent: string; last_run: string | null; runs_24h: string | number; revised_24h?: string | number }>`
      SELECT 'reprice' AS agent,
        MAX(created_at)::text AS last_run,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS runs_24h,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND success = TRUE)::int AS revised_24h
      FROM reprice_agent_log
      UNION ALL
      SELECT 'fulfillment' AS agent,
        MAX(created_at)::text AS last_run,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS runs_24h,
        NULL AS revised_24h
      FROM fulfillment_agent_tracker
      UNION ALL
      SELECT 'digest' AS agent,
        MAX(created_at)::text AS last_run,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS runs_24h,
        NULL AS revised_24h
      FROM performance_digests
    `.catch(() => []),
  ])

  const ebayMap = new Map(ebayRows.map((row) => [row.user_id, row]))
  const listingMap = new Map(listingRows.map((row) => [row.user_id, row]))
  const connectedUsers = ebayRows.filter((row) => row.connected).length
  const activeRecently = listingRows.filter((row) => {
    const last = row.last_listing_at ? new Date(row.last_listing_at) : null
    return last && Date.now() - last.getTime() < 30 * 24 * 60 * 60 * 1000
  }).length

  const summary = listingSummaryRows[0] || {}
  const source = sourceRows[0] || {}
  const cache = cacheRows[0] || {}
  const continuous = continuousRows[0] || {}
  const autoListingSettingsSummary = autoListingSettingsSummaryRows[0] || {}
  const autoListingQueueSummary = autoListingQueueSummaryRows[0] || {}
  const listingAvailabilitySummary = listingAvailabilitySummaryRows[0] || {}
  const sourceTotal = toNumber(source.total)
  const continuousCount = toNumber(continuous.count)
  const readyNiches = toNumber(cache.ready_niches)
  const totalNiches = toNumber(cache.total_niches)
  const runningAutoUsers = toNumber(autoListingSettingsSummary.running_users)
  const readyAutoQueue = toNumber(autoListingQueueSummary.queued) + toNumber(autoListingQueueSummary.retry)
  const dueListingAudits = toNumber(listingAvailabilitySummary.due_for_audit)
  const activeAuditListings = toNumber(listingAvailabilitySummary.active_listings)
  let autopilotUpdate: Awaited<ReturnType<typeof reserveSourceAutopilotRun>> | null = null
  const lowStockTrendingNiches = trendingNicheRows
    .map((row) => {
      const name = String(row.name || '').trim()
      const cacheProducts = toNumber(row.cache_products)
      const refreshedAt = toIso(row.cache_refreshed_at) || toIso(row.latest_seen)
      const refreshedDate = refreshedAt ? new Date(refreshedAt) : null
      const stale = !refreshedDate || Number.isNaN(refreshedDate.getTime()) || Date.now() - refreshedDate.getTime() > 36 * 60 * 60 * 1000
      return { name, cacheProducts, stale, refreshedAt }
    })
    .filter((item) => item.name && (item.cacheProducts < 30 || item.stale))
    .sort((a, b) => {
      if (a.cacheProducts < 30 && b.cacheProducts >= 30) return -1
      if (b.cacheProducts < 30 && a.cacheProducts >= 30) return 1
      return a.cacheProducts - b.cacheProducts || Date.parse(a.refreshedAt || '0') - Date.parse(b.refreshedAt || '0')
    })
    .map((item) => item.name)
  const recommendedWeakNiches = (sourceIntelligenceSummary?.recommendations || [])
    .filter((item) => item.readyProducts < 30 || item.cacheProducts < 30 || item.healthScore < 65)
    .map((item) => item.niche)
    .filter(Boolean)
  const weakAutopilotNiches = Array.from(new Set([...lowStockTrendingNiches, ...recommendedWeakNiches])).slice(0, 3)
  const shouldAutopilotRepair =
    weakAutopilotNiches.length > 0 ||
    continuousCount < 90 ||
    (sourceTotal > 0 && toNumber(source.stale) > sourceTotal * 0.45)

  if (shouldAutopilotRepair) {
    const reason = weakAutopilotNiches.length > 0
      ? `Repair weak niche cache: ${weakAutopilotNiches.join(', ')}`
      : continuousCount < 90
        ? 'Rebuild Continuous Listing queue below 90 ready products.'
        : 'Refresh stale source pool products.'
    autopilotUpdate = await reserveSourceAutopilotRun({
      reason,
      niches: weakAutopilotNiches,
      cooldownMinutes: weakAutopilotNiches.length > 0 ? 45 : 75,
    }).catch(() => null)

    if (autopilotUpdate?.reserved) {
      const origin = req.nextUrl.origin
      const cronSecret = process.env.CRON_SECRET || ''
      const headers: Record<string, string> = cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}
      const repairUrl = weakAutopilotNiches.length > 0
        ? `${origin}/api/cron/refresh-products?stockWeak=1&wait=1&autopilot=1&batch=${weakAutopilotNiches.length}&niche=${encodeURIComponent(weakAutopilotNiches.join(','))}`
        : `${origin}/api/cron/refresh-products?sourceOnly=1&autopilot=1`

      after(async () => {
        await fetch(repairUrl, {
          headers,
          signal: AbortSignal.timeout(285000),
        }).catch(() => null)
      })
    }
  }

  const sourceIntelligenceWithAutopilot = sourceIntelligenceSummary
    ? {
        ...sourceIntelligenceSummary,
        autopilot: {
          ...sourceIntelligenceSummary.autopilot,
          scheduledNow: Boolean(autopilotUpdate?.reserved),
          lastReason: autopilotUpdate?.reason || sourceIntelligenceSummary.autopilot?.lastReason || null,
          lastNiches: autopilotUpdate?.niches?.length ? autopilotUpdate.niches : sourceIntelligenceSummary.autopilot?.lastNiches || [],
          nextRunAfter: autopilotUpdate?.nextRunAfter || sourceIntelligenceSummary.autopilot?.nextRunAfter || null,
        },
      }
    : null

  const warnings: string[] = []
  if (users.length === 0) warnings.push('No user accounts exist yet.')
  if (users.length > 0 && connectedUsers < users.length) warnings.push('Some accounts have not connected eBay.')
  if (sourceTotal < 5000) warnings.push('Source engine pool is below the public-launch target of 5,000 active products.')
  if (continuousCount < 90) warnings.push('Continuous Listing pool has fewer than 90 ready products.')
  if (totalNiches > 0 && readyNiches < Math.max(1, Math.floor(totalNiches * 0.7))) warnings.push('Several niche caches are below the 30-product ready target; hourly niche stocker is refilling them.')
  if (toNumber(source.stale) > sourceTotal * 0.45) warnings.push('A large share of source products are older than 7 days.')
  if (sourceIntelligenceWithAutopilot?.failedJobs24h) warnings.push(`${sourceIntelligenceWithAutopilot.failedJobs24h} source engine job(s) failed in the last 24 hours.`)
  if (sourceIntelligenceWithAutopilot?.weakNiches) warnings.push(`${sourceIntelligenceWithAutopilot.weakNiches} niche(s) need source-engine self-healing.`)
  if (sourceIntelligenceWithAutopilot?.autopilot?.scheduledNow) warnings.push('Source autopilot started a background repair job.')
  if (runningAutoUsers > 0 && readyAutoQueue === 0) warnings.push('Auto Bulk is enabled but has no ready queue items yet.')
  if (dueListingAudits > Math.max(60, activeAuditListings * 0.5)) warnings.push('A large share of active listings are due for Amazon availability audit.')
  if (toNumber(summary.one_image_active) > 0) warnings.push(`${toNumber(summary.one_image_active)} active listing(s) confirmed with only 1 image — use the Listing Quality panel to end them.`)
  if (toNumber(summary.legacy_unaudited) > 0) warnings.push(`${toNumber(summary.legacy_unaudited)} active listing(s) have no image count recorded — run the Legacy Image Audit to classify them.`)
  if (toNumber(summary.missing_category_active) > 0) warnings.push(`${toNumber(summary.missing_category_active)} active listing(s) are missing a stored category id.`)

  const status = warnings.length === 0 ? 'healthy' : warnings.length <= 3 ? 'watch' : 'attention'

  const customers = users.map((user) => {
    const ebay = ebayMap.get(user.id)
    const listings = listingMap.get(user.id)
    return {
      id: user.id,
      email: user.email,
      name: user.name || '',
      joined: toIso(user.created_at),
      ebayConnected: Boolean(ebay?.connected),
      ebayUpdatedAt: toIso(ebay?.updated_at),
      ebayTokenExpiresAt: toIso(ebay?.token_expires_at),
      totalListings: toNumber(listings?.total_listings),
      activeListings: toNumber(listings?.active_listings),
      activeProfit: toNumber(listings?.active_profit),
      lastListingAt: toIso(listings?.last_listing_at),
      activeRecently: Boolean(listings?.last_listing_at && Date.now() - new Date(listings.last_listing_at).getTime() < 30 * 24 * 60 * 60 * 1000),
    }
  })

  return apiOk({
    generatedAt: new Date().toISOString(),
    status,
    warnings,
    totalUsers: users.length,
    ebayConnected: connectedUsers,
    activeRecently,
    customers,
    listingSummary: {
      totalListings: toNumber(summary.total_listings),
      activeListings: toNumber(summary.active_listings),
      listed7Days: toNumber(summary.listed_7),
      listed30Days: toNumber(summary.listed_30),
      lowImageActive: toNumber(summary.low_image_active),
      legacyUnaudited: toNumber(summary.legacy_unaudited),
      imageBreakdown: {
        oneImage: toNumber(summary.one_image_active),
        twoImages: toNumber(summary.two_image_active),
        threePlusImages: toNumber(summary.three_plus_image_active),
        qualityWarnings: toNumber(summary.image_quality_warnings),
      },
      missingCategoryActive: toNumber(summary.missing_category_active),
      activeRevenue: toNumber(summary.active_revenue),
      activeCost: toNumber(summary.active_cost),
      activeProfit: toNumber(summary.active_profit),
      averageRoi: toNumber(summary.average_roi),
    },
    sourceHealth: {
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
      sourceAgent: {
        enabled: true,
        provider: process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OPENROUTER_API_KEY ? 'openrouter' : 'deterministic',
        recentRuns: sourceAgentRuns.map((run) => ({
          id: String(run.id),
          provider: run.provider,
          status: run.status,
          plan: run.plan,
          metrics: run.metrics,
          error: run.error,
          durationMs: toNumber(run.duration_ms),
          createdAt: toIso(run.created_at),
        })),
      },
      intelligence: sourceIntelligenceWithAutopilot,
      agentStatus: {
        reprice: agentStatusRows.find((r) => r.agent === 'reprice') || null,
        fulfillment: agentStatusRows.find((r) => r.agent === 'fulfillment') || null,
        digest: agentStatusRows.find((r) => r.agent === 'digest') || null,
      },
      topNiches: sourceNicheRows.map((row) => ({
        name: row.name || 'Unassigned',
        count: toNumber(row.count),
        averageScore: toNumber(row.avg_score),
        maxScore: toNumber(row.max_score),
        newestSeenAt: toIso(row.newest_seen),
      })),
      trendingNiches: trendingNicheRows.map((row) => {
        const activeProducts = toNumber(row.active_products)
        const cacheProducts = toNumber(row.cache_products)
        const refreshedAt = toIso(row.cache_refreshed_at) || toIso(row.latest_seen)
        const refreshedDate = refreshedAt ? new Date(refreshedAt) : null
        const stale = !refreshedDate || Date.now() - refreshedDate.getTime() > 48 * 60 * 60 * 1000
        const status =
          activeProducts >= 30 && cacheProducts >= 30 && !stale
            ? 'ready'
            : activeProducts >= 10 || cacheProducts >= 10
              ? 'watch'
              : 'low'
        return {
          name: row.name || 'Unassigned',
          activeProducts,
          cacheProducts,
          averageProfit: toNumber(row.avg_profit),
          averageRoi: toNumber(row.avg_roi),
          averageScore: toNumber(row.avg_score),
          latestSeenAt: toIso(row.latest_seen),
          cacheRefreshedAt: toIso(row.cache_refreshed_at),
          missingImages: toNumber(row.missing_images),
          highRiskProducts: toNumber(row.high_risk),
          status,
        }
      }),
    },
    automation: {
      proCron: {
        sourceMaintenance: 'Every 30 minutes',
        nicheStock: 'Every hour',
        deepCatalog: 'Every 6 hours',
        autoBulk: 'Every 15 minutes',
        listingAuditBatch: 60,
      },
      autoListing: {
        totalSettings: toNumber(autoListingSettingsSummary.total_settings),
        enabledUsers: toNumber(autoListingSettingsSummary.enabled_users),
        runningUsers: runningAutoUsers,
        pausedUsers: toNumber(autoListingSettingsSummary.paused_users),
        emergencyStoppedUsers: toNumber(autoListingSettingsSummary.emergency_stopped_users),
        queued: toNumber(autoListingQueueSummary.queued),
        retry: toNumber(autoListingQueueSummary.retry),
        processing: toNumber(autoListingQueueSummary.processing),
        failed: toNumber(autoListingQueueSummary.failed),
        dueNow: toNumber(autoListingQueueSummary.due_now),
        readyQueue: readyAutoQueue,
        listed24h: toNumber(autoListingQueueSummary.listed_24h),
        averageScore: toNumber(autoListingQueueSummary.avg_score),
        oldestDueAt: toIso(autoListingQueueSummary.oldest_due_at),
        nextDueAt: toIso(autoListingQueueSummary.next_due_at),
        latestListedAt: toIso(autoListingQueueSummary.latest_listed_at),
      },
      listingAudit: {
        activeListings: activeAuditListings,
        markedUnavailable: toNumber(listingAvailabilitySummary.marked_unavailable),
        dueForAudit: dueListingAudits,
        checked24h: toNumber(listingAvailabilitySummary.checked_24h),
        lastCheckedAt: toIso(listingAvailabilitySummary.last_checked_at),
      },
    },
    recentListings: recentListingRows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      sellerName: row.seller_name || '',
      sellerEmail: row.seller_email,
      asin: row.asin || '',
      title: row.title || '',
      ebayListingId: row.ebay_listing_id || '',
      listedAt: toIso(row.listed_at),
      amazonPrice: toNumber(row.amazon_price),
      ebayPrice: toNumber(row.ebay_price),
      niche: row.niche || 'Unassigned',
      categoryId: row.category_id || '',
      imageCount: toNumber(row.image_count),
    })),
    problemListings: problemListingRows.map((row) => {
      const imageCount = toNumber(row.image_count)
      const cacheImageCount = toNumber(row.cache_image_count)
      const issues: string[] = []
      if (imageCount < 2) issues.push('Low stored images')
      if (!row.category_id) issues.push('Missing category id')
      if (row.cache_available === false) issues.push('Amazon unavailable in cache')

      return {
        id: row.id,
        userId: row.user_id,
        sellerName: row.seller_name || '',
        sellerEmail: row.seller_email,
        asin: row.asin || '',
        title: row.title || '',
        ebayListingId: row.ebay_listing_id || '',
        listedAt: toIso(row.listed_at),
        amazonPrice: toNumber(row.amazon_price),
        ebayPrice: toNumber(row.ebay_price),
        niche: row.niche || 'Unassigned',
        categoryId: row.category_id || '',
        categoryName: row.category_name || '',
        imageCount,
        cacheImageCount,
        cacheUpdatedAt: toIso(row.cache_updated_at),
        cacheAvailable: row.cache_available,
        issues,
        repairHint: cacheImageCount >= 2
          ? 'Amazon cache has images ready'
          : row.ebay_listing_id
            ? 'Can try eBay active listing data'
            : 'Needs fresh Amazon lookup',
      }
    }),
    nichePerformance: nichePerformanceRows.map((row) => ({
      niche: row.niche || 'Unassigned',
      listings: toNumber(row.listings),
      sellers: toNumber(row.sellers),
      revenue: toNumber(row.revenue),
      profit: toNumber(row.profit),
    })),
    tools: {
      poolRefresh: true,
      setupDatabase: true,
      listingAudit: true,
      checkOrders: true,
      collabViewer: true,
    },
  })
}
