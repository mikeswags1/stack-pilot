import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runRepriceAgent } from '@/lib/reprice-agent'
import { shouldSkipCronListing } from '@/lib/quota-tracker'

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authed = !cronSecret || authHeader === `Bearer ${cronSecret}` || isVercelCron
  if (!authed) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const urgentOnly = req.nextUrl.searchParams.get('urgentOnly') === '1'
  const userIdParam = req.nextUrl.searchParams.get('userId')
  const userId = userIdParam ? Number(userIdParam) : undefined

  if (userId !== undefined && !Number.isFinite(userId)) {
    return apiError('Invalid userId.', { status: 400, code: 'INVALID_USER' })
  }

  // Soft-throttle when eBay quota is high — reprice uses ReviseFixedPriceItem which
  // shares the same hourly bucket as listing. Skip this cycle to leave room for users.
  if (!dryRun && await shouldSkipCronListing().catch(() => false)) {
    return apiOk({ ok: true, skipped: 'ebay_quota_throttled' })
  }

  const result = await runRepriceAgent({ dryRun, userId, urgentOnly })
  return apiOk({ ok: true, ...result })
}
