import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { warmAmazonProductCache } from '@/lib/amazon-product'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Mass-enrich amazon_product_cache from product_source_items.
 *
 * Pool products start with only image_url (1 image from search results). Until cache
 * is populated, getProductImageCount() returns 1 and the old isPublishReadyProduct >= 2
 * gate would hide them. Now publishing accepts 1+ images, but cached enrichment still
 * improves listing quality (multi-image galleries, real descriptions, full specs).
 *
 * Auth: admin session OR CRON_SECRET bearer.
 * Body / query: limit (default 80, max 200 — Vercel's 300s function cap limits batch size).
 * Returns: { warmed, failed, durationMs }
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
  const limit = Number.isFinite(Number(limitRaw))
    ? Math.min(200, Math.max(1, Number(limitRaw)))
    : 80

  // Optional niche filter — pass either an array in JSON body { niches: [...] }
  // or a comma-separated query param ?niches=Foo,Bar
  let niches: string[] | undefined
  if (Array.isArray(body.niches)) {
    niches = (body.niches as unknown[]).map((n) => String(n)).filter((n) => n.length > 0)
  } else if (query.get('niches')) {
    niches = String(query.get('niches')).split(',').map((n) => n.trim()).filter((n) => n.length > 0)
  }

  const startedAt = Date.now()
  const result = await warmAmazonProductCache(limit, { niches })
  return apiOk({ ...result, limit, nicheFilter: niches?.length || 0, durationMs: Date.now() - startedAt })
}
