import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runDemandScout } from '@/lib/demand-scout'

export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Standard cron auth: Vercel cron sets `x-vercel-cron`, manual triggers must include
  // Authorization: Bearer ${CRON_SECRET}.
  const cronSecret = process.env.CRON_SECRET || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const isAuthorized = req.headers.get('authorization') === `Bearer ${cronSecret}`
  if (!isVercelCron && !isAuthorized) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  const seedsPerRun = Math.max(1, Math.min(Number(req.nextUrl.searchParams.get('seedsPerRun') || 6), 20))
  const perSeed = Math.max(5, Math.min(Number(req.nextUrl.searchParams.get('perSeed') || 15), 30))

  const startedAt = Date.now()
  const summary = await runDemandScout({ seedsPerRun, perSeed }).catch((err) => ({
    error: String(err instanceof Error ? err.message : err).slice(0, 300),
  }))

  console.info('[demand-scout]', JSON.stringify({ ...summary, durationMs: Date.now() - startedAt }))
  return apiOk({ ok: true, durationMs: Date.now() - startedAt, ...summary })
}
