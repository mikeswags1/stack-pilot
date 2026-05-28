import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows } from '@/lib/db'
import { ensureQuotaTables, getQuotaSummary } from '@/lib/quota-tracker'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || ''
  const authHeader = req.headers.get('authorization') || ''
  const tokenAuthed = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`
  if (!tokenAuthed) {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
      return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
    }
  }

  await ensureQuotaTables()

  // ── Pool & listings ──
  const [poolStats, listingStats, listingsToday, failuresToday, repriceStats, cacheFreshness, staleListings, topFailures] = await Promise.all([
    queryRows<{ active: string | number; cached: string | number; with_2plus_images: string | number }>`
      SELECT
        COUNT(*) FILTER (WHERE psi.active = TRUE)::int AS active,
        COUNT(*) FILTER (WHERE psi.active = TRUE AND apc.asin IS NOT NULL)::int AS cached,
        COUNT(*) FILTER (WHERE psi.active = TRUE AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2)::int AS with_2plus_images
      FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    `.catch(() => []),
    queryRows<{ total_active: string | number; with_image_warning: string | number; listed_today: string | number; listed_7d: string | number }>`
      SELECT
        COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS total_active,
        COUNT(*) FILTER (WHERE ended_at IS NULL AND image_quality_warning = TRUE)::int AS with_image_warning,
        COUNT(*) FILTER (WHERE listed_at > NOW() - INTERVAL '24 hours')::int AS listed_today,
        COUNT(*) FILTER (WHERE listed_at > NOW() - INTERVAL '7 days')::int AS listed_7d
      FROM listed_asins
    `.catch(() => []),
    queryRows<{ source: string; n: string | number }>`
      SELECT 'cron' AS source, COUNT(*)::int AS n
      FROM auto_listing_logs
      WHERE event_type = 'listed' AND created_at > NOW() - INTERVAL '24 hours'
    `.catch(() => []),
    queryRows<{ error_code: string; n: string | number; last_at: string | null }>`
      SELECT error_code, COUNT(*)::int AS n, MAX(created_at)::text AS last_at
      FROM listing_failure_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY error_code ORDER BY n DESC LIMIT 10
    `.catch(() => []),
    queryRows<{ total_active: string | number; never_repriced: string | number; stale_reprice: string | number; median_lag_hours: string | number | null }>`
      SELECT
        COUNT(*)::int AS total_active,
        COUNT(*) FILTER (WHERE last_repriced_at IS NULL)::int AS never_repriced,
        COUNT(*) FILTER (WHERE last_repriced_at IS NOT NULL AND last_repriced_at < NOW() - INTERVAL '24 hours')::int AS stale_reprice,
        ROUND(EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY NOW() - last_repriced_at)) / 3600.0, 1) AS median_lag_hours
      FROM listed_asins
      WHERE ended_at IS NULL AND amazon_price IS NOT NULL AND amazon_price > 0
    `.catch(() => []),
    queryRows<{ fresh_6h: string | number; fresh_24h: string | number; fresh_7d: string | number; stale_7d_plus: string | number }>`
      SELECT
        COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '6 hours')::int AS fresh_6h,
        COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '24 hours')::int AS fresh_24h,
        COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days')::int AS fresh_7d,
        COUNT(*) FILTER (WHERE updated_at <= NOW() - INTERVAL '7 days' OR updated_at IS NULL)::int AS stale_7d_plus
      FROM amazon_product_cache
    `.catch(() => []),
    queryRows<{ stale_24h: string | number; stale_72h: string | number; stale_7d: string | number }>`
      SELECT
        COUNT(*) FILTER (WHERE apc.updated_at < NOW() - INTERVAL '24 hours' OR apc.asin IS NULL)::int AS stale_24h,
        COUNT(*) FILTER (WHERE apc.updated_at < NOW() - INTERVAL '72 hours' OR apc.asin IS NULL)::int AS stale_72h,
        COUNT(*) FILTER (WHERE apc.updated_at < NOW() - INTERVAL '7 days' OR apc.asin IS NULL)::int AS stale_7d
      FROM listed_asins la
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(la.asin)
      WHERE la.ended_at IS NULL
    `.catch(() => []),
    queryRows<{ stage: string; n: string | number }>`
      SELECT stage, COUNT(*)::int AS n
      FROM listing_failure_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY stage ORDER BY n DESC
    `.catch(() => []),
  ])

  // ── External API quota usage (from api_usage_log) ──
  const apiQuotas = await getQuotaSummary()

  // ── Aggregate provider totals (rolled up across all call names) ──
  const providers = Array.from(new Set(apiQuotas.map((entry) => entry.provider)))
  const providerTotals = providers.map((provider) => {
    const entries = apiQuotas.filter((entry) => entry.provider === provider)
    const daily = entries.reduce((sum, entry) => sum + entry.dailyUsage, 0)
    const hourly = entries.reduce((sum, entry) => sum + entry.hourlyUsage, 0)
    const failures = entries.reduce((sum, entry) => sum + entry.recentFailures, 0)
    const worstStatus: 'ok' | 'warn' | 'block' =
      entries.some((entry) => entry.status === 'block') ? 'block' :
      entries.some((entry) => entry.status === 'warn') ? 'warn' : 'ok'
    return { provider, dailyTotal: daily, hourlyTotal: hourly, failures24h: failures, status: worstStatus }
  })

  // ── Top-line warnings (drive the red/yellow banners on the UI) ──
  const warnings: Array<{ level: 'warn' | 'block'; title: string; message: string }> = []
  for (const entry of apiQuotas) {
    if (entry.status === 'block') {
      warnings.push({
        level: 'block',
        title: `${entry.provider} ${entry.callName} quota near limit`,
        message: `${entry.dailyUsage}/${entry.rule.dailyHardLimit} daily (${Math.round(entry.dailyPct * 100)}%). New listings BLOCKED. Quota resets at midnight Pacific.`,
      })
    } else if (entry.status === 'warn') {
      warnings.push({
        level: 'warn',
        title: `${entry.provider} ${entry.callName} approaching limit`,
        message: `${entry.dailyUsage}/${entry.rule.dailyHardLimit} daily (${Math.round(entry.dailyPct * 100)}%). Cron auto-listing throttled. Manual listings still allowed.`,
      })
    }
  }
  if (Number(listingStats[0]?.with_image_warning || 0) > 5) {
    warnings.push({
      level: 'warn',
      title: 'Listings with image quality warnings',
      message: `${listingStats[0].with_image_warning} active listings flagged with <2 images. Review and re-list.`,
    })
  }
  if (Number(repriceStats[0]?.stale_reprice || 0) > Number(repriceStats[0]?.total_active || 1) * 0.5) {
    warnings.push({
      level: 'warn',
      title: 'Repricing falling behind',
      message: `${repriceStats[0].stale_reprice}/${repriceStats[0].total_active} active listings have not been repriced in 24h.`,
    })
  }

  return apiOk({
    generatedAt: new Date().toISOString(),
    pool: poolStats[0] || { active: 0, cached: 0, with_2plus_images: 0 },
    listings: {
      active: Number(listingStats[0]?.total_active || 0),
      withImageWarning: Number(listingStats[0]?.with_image_warning || 0),
      listedToday: Number(listingStats[0]?.listed_today || 0),
      listedLast7Days: Number(listingStats[0]?.listed_7d || 0),
      cronListedToday: Number(listingsToday[0]?.n || 0),
    },
    failures24h: {
      byCode: failuresToday.map((row) => ({ errorCode: row.error_code, count: Number(row.n), lastAt: row.last_at })),
      byStage: topFailures.map((row) => ({ stage: row.stage, count: Number(row.n) })),
    },
    repricing: repriceStats[0]
      ? {
          activeListings: Number(repriceStats[0].total_active),
          neverRepriced: Number(repriceStats[0].never_repriced),
          staleReprice: Number(repriceStats[0].stale_reprice),
          medianLagHours: repriceStats[0].median_lag_hours,
        }
      : null,
    cacheFreshness: cacheFreshness[0] || { fresh_6h: 0, fresh_24h: 0, fresh_7d: 0, stale_7d_plus: 0 },
    listingsCloseToStale: staleListings[0] || { stale_24h: 0, stale_72h: 0, stale_7d: 0 },
    apiQuotas,
    providerTotals,
    warnings,
  })
}
