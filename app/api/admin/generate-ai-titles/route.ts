import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows } from '@/lib/db'
import { getOrGenerateAiTitle } from '@/lib/ai-title-generator'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Bulk-generate AI-optimized eBay titles for ASINs that have cached Amazon data
 * but no cached AI title yet.
 *
 * Auth: admin session OR CRON_SECRET bearer.
 * Body/query: limit (default 80, max 200). Optional niches[] to filter.
 * Cost: ~$0.0002 per title via Claude Haiku.
 */
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || ''
  const authHeader = req.headers.get('authorization') || ''
  const tokenAuthed = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`
  if (!tokenAuthed) {
    const session = await getServerSession(authOptions)
    if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
      return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
    }
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const query = req.nextUrl.searchParams
  const limitRaw = body.limit ?? query.get('limit')
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(200, Math.max(1, Number(limitRaw))) : 80
  const niches: string[] = Array.isArray(body.niches)
    ? (body.niches as unknown[]).map(String).filter((n) => n.length > 0)
    : []
  const useNicheFilter = niches.length > 0

  // Find ASINs that have rich cached Amazon data but no AI title yet, prioritized by master_score
  const rows = useNicheFilter
    ? await queryRows<{ asin: string; title: string; niche: string | null; specs: unknown }>`
        SELECT psi.asin, apc.title, psi.source_niche AS niche, apc.specs
        FROM product_source_items psi
        JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
        LEFT JOIN ebay_title_cache etc ON UPPER(etc.asin) = UPPER(psi.asin) AND etc.expires_at > NOW()
        WHERE psi.active = TRUE
          AND etc.asin IS NULL
          AND apc.title IS NOT NULL AND LENGTH(apc.title) > 10
          AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
          AND COALESCE(apc.available, TRUE) <> FALSE
          AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
          AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
          AND psi.source_niche = ANY(${niches}::text[])
        ORDER BY psi.master_score DESC NULLS LAST
        LIMIT ${limit}
      `.catch(() => [])
    : await queryRows<{ asin: string; title: string; niche: string | null; specs: unknown }>`
        SELECT psi.asin, apc.title, psi.source_niche AS niche, apc.specs
        FROM product_source_items psi
        JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
        LEFT JOIN ebay_title_cache etc ON UPPER(etc.asin) = UPPER(psi.asin) AND etc.expires_at > NOW()
        WHERE psi.active = TRUE
          AND etc.asin IS NULL
          AND apc.title IS NOT NULL AND LENGTH(apc.title) > 10
          AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
          AND COALESCE(apc.available, TRUE) <> FALSE
          AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
          AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
        ORDER BY psi.master_score DESC NULLS LAST
        LIMIT ${limit}
      `.catch(() => [])

  if (rows.length === 0) {
    return apiOk({ scanned: 0, generated: 0, failed: 0, durationMs: 0, message: 'No ASINs need AI titles' })
  }

  const startedAt = Date.now()
  let generated = 0, failed = 0

  // Process serially with a small gap so we don't hammer the Anthropic API.
  for (const row of rows) {
    const specs = Array.isArray(row.specs) ? (row.specs as Array<[string, string]>) : []
    const result = await getOrGenerateAiTitle({
      asin: row.asin,
      amazonTitle: row.title,
      niche: row.niche,
      specs,
    }).catch(() => null)
    if (result) generated++
    else failed++
    // tiny throttle to be polite
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return apiOk({
    scanned: rows.length,
    generated,
    failed,
    nicheFilter: useNicheFilter ? niches.length : 0,
    durationMs: Date.now() - startedAt,
  })
}
