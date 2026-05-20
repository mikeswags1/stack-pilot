import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runFulfillmentAgent } from '@/lib/fulfillment-agent'

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authed = !cronSecret || authHeader === `Bearer ${cronSecret}` || isVercelCron
  if (!authed) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const userId = req.nextUrl.searchParams.get('userId') || undefined

  const result = await runFulfillmentAgent({ dryRun, userId })
  return apiOk({ ok: true, ...result })
}
