import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runRepriceAgent } from '@/lib/reprice-agent'

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authed = !cronSecret || authHeader === `Bearer ${cronSecret}` || isVercelCron
  if (!authed) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const userIdParam = req.nextUrl.searchParams.get('userId')
  const userId = userIdParam ? Number(userIdParam) : undefined

  if (userId !== undefined && !Number.isFinite(userId)) {
    return apiError('Invalid userId.', { status: 400, code: 'INVALID_USER' })
  }

  const result = await runRepriceAgent({ dryRun, userId })
  return apiOk({ ok: true, ...result })
}
