// Phase 1 — Niche lifecycle cron.
//
// Once a day this:
//   1) Refreshes source_niche_intelligence (the existing aggregation)
//   2) Computes lifecycle_state / lifecycle_reason / diagnostics for every niche
//   3) Auto-pauses seasonal_expired niches that are past their retire-grace window
//
// Cheap to run — pure DB aggregation, no external API calls.

import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { refreshSourceIntelligenceState } from '@/lib/source-intelligence'
import { refreshNicheLifecycle } from '@/lib/niche-funnel'
import { refreshMarketSaturation } from '@/lib/market-saturation'

export const maxDuration = 120
export const dynamic = 'force-dynamic'

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

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'

  const startedAt = Date.now()

  // Step 1: rebuild the underlying per-niche aggregation (existing logic).
  const refresh = await refreshSourceIntelligenceState({ applyScores: false }).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
    nichesAnalyzed: 0,
  }))

  // Step 2: compute lifecycle state, persist, and (if not dryRun) auto-pause seasonal_expired.
  const lifecycle = await refreshNicheLifecycle({ autoPauseExpired: !dryRun }).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
    rows: [],
    pausedSeasonalNiches: [] as string[],
  }))

  const stateCounts = ('rows' in lifecycle ? lifecycle.rows : []).reduce(
    (acc, row) => {
      acc[row.state] = (acc[row.state] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )

  // Step 3: market saturation + inventory quality + duplicate clustering (pure DB, cheap).
  // Runs after lifecycle so niche sold_30d / sell-through are in place for supply-demand math.
  const saturation = await refreshMarketSaturation().catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }))

  return apiOk({
    ok: true,
    dryRun,
    durationMs: Date.now() - startedAt,
    refresh,
    lifecycle: {
      nichesAnalyzed: 'rows' in lifecycle ? lifecycle.rows.length : 0,
      stateCounts,
      pausedSeasonalNiches: 'pausedSeasonalNiches' in lifecycle ? lifecycle.pausedSeasonalNiches : [],
      error: 'error' in lifecycle ? lifecycle.error : undefined,
    },
    saturation,
  })
}
