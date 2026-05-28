// Phase 4 — Graph discovery + staged enrichment cron.
//
// Runs the scalable inventory funnel on a schedule:
//   1) runGraphDiscovery     — FREE recursive expansion of the ASIN universe (scrape-based)
//   2) enrichTopCandidates   — quota-gated RapidAPI enrichment of the strongest raw candidates
//   3) reactivateDormant     — low-frequency revival of old/stale candidates
//
// Discovery is free + high-volume; enrichment + reactivation are quota-gated inside their
// own functions, so this cron is safe to run frequently without busting the RapidAPI budget.

import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { runGraphDiscovery, reactivateDormantCandidates, getDiscoverySettings } from '@/lib/source-graph'
import { enrichTopCandidates } from '@/lib/staged-enrichment'

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
  const skipDiscovery = req.nextUrl.searchParams.get('skipDiscovery') === '1'
  const skipEnrichment = req.nextUrl.searchParams.get('skipEnrichment') === '1'
  const skipReactivation = req.nextUrl.searchParams.get('skipReactivation') === '1'

  const settings = await getDiscoverySettings()

  // KILL SWITCH — settings.enabled=false halts ALL graph activity (discovery + enrichment +
  // reactivation). Flip it from /admin/discovery if scraping/RapidAPI throttling or bad data
  // shows up. Returns immediately so no Amazon/RapidAPI calls are made.
  if (!settings.enabled) {
    return apiOk({
      ok: true,
      durationMs: Date.now() - startedAt,
      settings,
      skipped: 'graph_discovery_disabled',
    })
  }

  // Step 1: discovery (free). Bounded so we leave time for enrichment.
  const discovery = skipDiscovery
    ? { skipped: 'disabled_by_param' }
    : await runGraphDiscovery({ maxRuntimeMs: 180_000 }).catch((err) => ({
        error: err instanceof Error ? err.message : String(err),
      }))

  // Step 2: staged enrichment (quota-gated, budgeted).
  const enrichment = skipEnrichment
    ? { skipped: 'disabled_by_param' }
    : await enrichTopCandidates({ budget: settings.enrichmentBudget, maxRuntimeMs: 80_000 }).catch((err) => ({
        error: err instanceof Error ? err.message : String(err),
      }))

  // Step 3: reactivation (quota-gated inside).
  const reactivation = skipReactivation
    ? { skipped: 'disabled_by_param' }
    : await reactivateDormantCandidates(settings.reactivationBatch).catch((err) => ({
        error: err instanceof Error ? err.message : String(err),
      }))

  return apiOk({
    ok: true,
    durationMs: Date.now() - startedAt,
    settings,
    discovery,
    enrichment,
    reactivation,
  })
}
