import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { backfillProductScores } from '@/lib/product-source-engine'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Admin trigger to recompute master_score / intelligence_score for active pool
 * rows that are unscored (NULL) or below floor (< MIN_MASTER_SCORE).
 *
 * Auth: admin session OR CRON_SECRET bearer token.
 *
 * Body / query options:
 *   limit         — max rows to scan per call (default 5000, max 10000)
 *   onlyUnscored  — '1'/'true' (default) to target only NULL/below-floor;
 *                    '0'/'false' to re-score every active row
 *
 * Returns: { scanned, updated, deactivated, skipped, durationMs }
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
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(10000, Math.max(1, Number(limitRaw))) : 5000

  const onlyRaw = body.onlyUnscored ?? query.get('onlyUnscored')
  const onlyUnscored = onlyRaw === undefined || onlyRaw === null
    ? true
    : String(onlyRaw).toLowerCase() !== 'false' && onlyRaw !== '0' && onlyRaw !== 0

  const startedAt = Date.now()
  const result = await backfillProductScores({ limit, onlyUnscored })
  return apiOk({ ...result, limit, onlyUnscored, durationMs: Date.now() - startedAt })
}
