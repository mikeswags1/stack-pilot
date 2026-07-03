import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runDigestAgent } from '@/lib/digest-agent'
import { sql } from '@/lib/db'

export const maxDuration = 120

// Diagnostic-history tables grow forever and inflate Neon storage/compute.
// Prune rows older than 90 days once a day (piggybacks on this daily cron).
// These are logs/traces only — never listings, orders, products, or settings.
async function pruneOldDiagnostics() {
  const pruned: Record<string, number> = {}
  const runs: Array<[string, () => Promise<unknown>]> = [
    ['api_usage_log', () => sql`DELETE FROM api_usage_log WHERE created_at < NOW() - INTERVAL '90 days'`],
    ['listing_failure_log', () => sql`DELETE FROM listing_failure_log WHERE created_at < NOW() - INTERVAL '90 days'`],
    ['source_engine_runs', () => sql`DELETE FROM source_engine_runs WHERE created_at < NOW() - INTERVAL '90 days'`],
    ['demand_scout_trace', () => sql`DELETE FROM demand_scout_trace WHERE created_at < NOW() - INTERVAL '90 days'`],
  ]
  for (const [table, run] of runs) {
    try {
      const result = (await run()) as unknown[]
      pruned[table] = Array.isArray(result) ? result.length : 0
    } catch { /* table may not exist yet — skip */ }
  }
  return pruned
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const isVercelCron = req.headers.get('x-vercel-cron') === '1'
  const authed = !cronSecret || authHeader === `Bearer ${cronSecret}` || isVercelCron
  if (!authed) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const force = req.nextUrl.searchParams.get('force') === '1'
  const result = await runDigestAgent({ force })
  const pruned = await pruneOldDiagnostics().catch(() => ({}))
  return apiOk({ ok: true, ...result, pruned })
}
