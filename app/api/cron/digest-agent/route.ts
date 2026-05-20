import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runDigestAgent } from '@/lib/digest-agent'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authed = !cronSecret || authHeader === `Bearer ${cronSecret}` || isVercelCron
  if (!authed) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const force = req.nextUrl.searchParams.get('force') === '1'
  const result = await runDigestAgent({ force })
  return apiOk({ ok: true, ...result })
}
