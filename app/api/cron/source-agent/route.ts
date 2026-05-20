import { after, NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runSourceAgent } from '@/lib/source-agent'

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authed = !cronSecret || authHeader === `Bearer ${cronSecret}` || isVercelCron
  if (!authed) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const result = await runSourceAgent({
    origin: req.nextUrl.origin,
    cronSecret,
    trigger: req.nextUrl.searchParams.get('source') || 'cron',
    dryRun,
  })

  if (result.ok && !dryRun && result.refreshUrl) {
    const headers: Record<string, string> = cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}
    after(async () => {
      await fetch(result.refreshUrl, {
        headers,
        signal: AbortSignal.timeout(285000),
      }).catch(() => null)
    })
  }

  return apiOk(result)
}
