import { type NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiOk, apiError } from '@/lib/api-response'
import { queryRows } from '@/lib/db'
import { getSourceReadinessAudit } from '@/lib/source-readiness-audit'

export const dynamic = 'force-dynamic'

// Admin-only (2026-06-11): exposes platform-wide pool/listing stats.
const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  const niche = req.nextUrl.searchParams.get('niche') || null

  const [totalPoolRows, totalListedRows, totalValidRows, validByNicheRows, readinessAudit] = await Promise.all([
    queryRows<{ n: string }>`SELECT COUNT(*) as n FROM product_source_items WHERE active = TRUE`,
    queryRows<{ n: string }>`SELECT COUNT(DISTINCT asin) as n FROM listed_asins WHERE ended_at IS NULL`,
    queryRows<{ n: string }>`
      SELECT COUNT(*) as n FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      WHERE psi.active = TRUE
        AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
        AND psi.image_url IS NOT NULL AND psi.image_url <> ''
        AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
        AND COALESCE(apc.available, TRUE) <> FALSE
        AND apc.fast_fulfillment IS DISTINCT FROM FALSE
        AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
        AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
        AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
        AND apc.asin IS NOT NULL
        AND jsonb_typeof(apc.images) = 'array'
        AND jsonb_array_length(apc.images) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM listed_asins la
          WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
        )
    `,
    queryRows<{ source_niche: string | null; valid_count: string }>`
      SELECT psi.source_niche, COUNT(*) as valid_count
      FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      WHERE psi.active = TRUE
        AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
        AND psi.image_url IS NOT NULL AND psi.image_url <> ''
        AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
        AND COALESCE(apc.available, TRUE) <> FALSE
        AND apc.fast_fulfillment IS DISTINCT FROM FALSE
        AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
        AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
        AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
        AND apc.asin IS NOT NULL
        AND jsonb_typeof(apc.images) = 'array'
        AND jsonb_array_length(apc.images) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM listed_asins la
          WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
        )
      GROUP BY psi.source_niche ORDER BY valid_count DESC LIMIT 40
    `,
    getSourceReadinessAudit().catch(() => null),
  ])

  let nicheStats: Record<string, number | string> | null = null
  if (niche) {
    const [nicheStatsRow] = await queryRows<{
      total: string
      ready: string
      rejected: string
      no_image: string
      bad_margins: string
      truly_valid: string
    }>`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE source_quality = 'ready') as ready,
        COUNT(*) FILTER (WHERE source_quality = 'reject') as rejected,
        COUNT(*) FILTER (WHERE image_url IS NULL OR image_url = '') as no_image,
        COUNT(*) FILTER (WHERE profit < 3 OR roi < 25 OR risk = 'HIGH') as bad_margins,
        COUNT(*) FILTER (
          WHERE profit >= 3 AND roi >= 25 AND risk <> 'HIGH'
            AND image_url IS NOT NULL AND image_url <> ''
            AND COALESCE(source_quality, 'candidate') <> 'reject'
            AND NOT EXISTS (
              SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(product_source_items.asin) AND la.ended_at IS NULL
            )
        ) as truly_valid
      FROM product_source_items WHERE active = TRUE AND source_niche = ${niche}
    `
    if (nicheStatsRow) {
      nicheStats = {
        niche,
        total: Number(nicheStatsRow.total),
        ready: Number(nicheStatsRow.ready),
        rejected: Number(nicheStatsRow.rejected),
        noImage: Number(nicheStatsRow.no_image),
        badMargins: Number(nicheStatsRow.bad_margins),
        trulyValid: Number(nicheStatsRow.truly_valid),
      }
    }
  }

  return apiOk({
    totalPool: Number(totalPoolRows[0]?.n ?? 0),
    totalAlreadyListed: Number(totalListedRows[0]?.n ?? 0),
    totalTrulyValid: Number(totalValidRows[0]?.n ?? 0),
    readinessAudit,
    nicheStats,
    validByNiche: validByNicheRows.map((r) => ({
      niche: r.source_niche,
      validCount: Number(r.valid_count),
    })),
  })
}
