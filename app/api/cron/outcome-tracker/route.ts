// Phase 2 — Outcome tracker cron (the learning loop heartbeat).
//
// Runs hourly and:
//   1) Pulls sales + cancellations from eBay (Sell API — cheap, separate quota)
//   2) Recomputes price-reduction counts from reprice_agent_log
//   3) Refreshes engagement (watch/hit) for the stalest N listings — quota-gated + batched
//   4) Scores every recently-touched listing (performance_score)
//   5) Feeds per-ASIN performance into sourcing (listing_outcome_score)
//   6) Rolls per-niche sell-through into source_niche_intelligence (outcome_multiplier)
//
// Steps 1-2 + 4-6 are pure DB / cheap API. Step 3 is the only Trading-API-heavy step and is
// capped at ?engagementLimit (default 25) and skipped entirely when eBay quota is non-OK.

import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import {
  pullSaleOutcomes,
  pullEngagementMetrics,
  recomputeReductionCounts,
} from '@/lib/listing-outcomes'
import {
  scoreAllListings,
  applyPerformanceToSourcing,
  applyNicheOutcomeWeighting,
} from '@/lib/performance-scoring'

export const maxDuration = 300
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

  const startedAt = Date.now()
  const userIdParam = req.nextUrl.searchParams.get('userId')
  const userId = userIdParam ? Number(userIdParam) : undefined
  const daysBack = Number(req.nextUrl.searchParams.get('daysBack') || '7') || 7
  const engagementLimit = Number(req.nextUrl.searchParams.get('engagementLimit') || '25') || 25
  const skipEngagement = req.nextUrl.searchParams.get('skipEngagement') === '1'

  // Step 1: sales + cancellations
  const sales = await pullSaleOutcomes({ userId, daysBack }).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }))

  // Step 2: price reductions
  const reductions = await recomputeReductionCounts().catch(() => ({ ok: false }))

  // Step 3: engagement (quota-gated inside the function)
  const engagement = skipEngagement
    ? { checked: 0, updated: 0, skipped: 'disabled' as const }
    : await pullEngagementMetrics({ limit: engagementLimit, userId }).catch((err) => ({
        checked: 0,
        updated: 0,
        skipped: (err instanceof Error ? err.message : String(err)) as string,
      }))

  // Step 4: score listings
  const scoring = await scoreAllListings({ windowDays: 120 }).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
    scored: 0,
  }))

  // Step 5: feed sourcing multiplier per ASIN
  const sourcing = await applyPerformanceToSourcing().catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }))

  // Step 6: niche outcome weighting
  const nicheWeighting = await applyNicheOutcomeWeighting().catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }))

  return apiOk({
    ok: true,
    durationMs: Date.now() - startedAt,
    sales,
    reductions,
    engagement,
    scoring,
    sourcing,
    nicheWeighting,
  })
}
