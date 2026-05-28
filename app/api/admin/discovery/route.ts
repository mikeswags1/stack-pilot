// Phase 4 — Discovery admin endpoint.
//
// GET  → breadth metrics + per-depth analytics + current settings.
// POST → { action: 'settings', settings: {...} } update controls
//        { action: 'discover' } run one discovery pass now
//        { action: 'enrich' }   run one enrichment pass now
//        { action: 'reactivate' } run one reactivation pass now

import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import {
  getSourcingBreadthMetrics,
  getDiscoverySettings,
  updateDiscoverySettings,
  runGraphDiscovery,
  reactivateDormantCandidates,
  type DiscoverySettings,
} from '@/lib/source-graph'
import { enrichTopCandidates } from '@/lib/staged-enrichment'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) return null
  return session
}

export async function GET(_req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  const [metrics, settings] = await Promise.all([getSourcingBreadthMetrics(), getDiscoverySettings()])
  return apiOk({ generatedAt: new Date().toISOString(), ...metrics, settings })
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const action = String(body?.action || '')

  if (action === 'settings') {
    const patch = (body?.settings || {}) as Partial<DiscoverySettings>
    const updated = await updateDiscoverySettings(patch)
    return apiOk({ ok: true, settings: updated })
  }

  // Manual triggers also respect the kill switch — if discovery is disabled, nothing runs
  // (no Amazon scrapes, no RapidAPI calls), even from the admin buttons.
  if (action === 'discover' || action === 'enrich' || action === 'reactivate') {
    const settings = await getDiscoverySettings()
    if (!settings.enabled) {
      return apiOk({ ok: true, skipped: 'graph_discovery_disabled', hint: 'Enable discovery in controls first.' })
    }
    if (action === 'discover') {
      const result = await runGraphDiscovery({ maxRuntimeMs: 60_000 })
      return apiOk({ ok: true, discovery: result })
    }
    if (action === 'enrich') {
      const result = await enrichTopCandidates({ budget: settings.enrichmentBudget, maxRuntimeMs: 60_000 })
      return apiOk({ ok: true, enrichment: result })
    }
    const result = await reactivateDormantCandidates(settings.reactivationBatch)
    return apiOk({ ok: true, reactivation: result })
  }

  return apiError('Unknown action.', { status: 400, code: 'UNKNOWN_ACTION' })
}
