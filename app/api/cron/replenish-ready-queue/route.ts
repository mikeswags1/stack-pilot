import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runReadyQueueReplenishment } from '@/lib/source-replenishment'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

function getNumberParam(req: NextRequest, name: string, fallback: number) {
  const value = Number(req.nextUrl.searchParams.get(name) || '')
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const secretParam = req.nextUrl.searchParams.get('secret') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authed =
    !cronSecret ||
    authHeader === `Bearer ${cronSecret}` ||
    (secretParam && cronSecret && secretParam === cronSecret) ||
    isVercelCron

  if (!authed) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const result = await runReadyQueueReplenishment({
    platformTarget: getNumberParam(req, 'platformTarget', 300),
    rawCandidateTarget: getNumberParam(req, 'rawTarget', 5000),
    maxRuntimeMs: getNumberParam(req, 'maxRuntimeMs', 240_000),
    force: req.nextUrl.searchParams.get('force') === '1',
    dryRun: req.nextUrl.searchParams.get('dryRun') === '1',
  })

  return apiOk({
    ok: true,
    message:
      result.after.platformReady >= result.platformTarget
        ? `Ready queue healthy: ${result.after.platformReady}/${result.platformTarget} platform-ready products.`
        : `Ready queue below target: ${result.after.platformReady}/${result.platformTarget} platform-ready products. Replenishment will continue next run.`,
    result,
  })
}
