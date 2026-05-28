// Phase 1 — Niche-health admin endpoint.
//
// GET  → returns persisted lifecycle rows (fast read)
// POST → triggers refreshNicheLifecycle (slower; used by "Refresh" button in UI)
//        Body: { autoPause?: boolean } — when true, also auto-pauses seasonal_expired niches

import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { getNicheLifecycleRows, refreshNicheLifecycle } from '@/lib/niche-funnel'
import { refreshSourceIntelligenceState } from '@/lib/source-intelligence'
import { setCustomSourceNicheActive } from '@/lib/source-niches'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return null
  }
  return session
}

export async function GET(_req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const rows = await getNicheLifecycleRows()
  return apiOk({
    generatedAt: new Date().toISOString(),
    niches: rows,
    summary: {
      total: rows.length,
      active: rows.filter((r) => r.state === 'active').length,
      watch: rows.filter((r) => r.state === 'watch').length,
      stale: rows.filter((r) => r.state === 'stale').length,
      paused: rows.filter((r) => r.state === 'paused').length,
      seasonalExpired: rows.filter((r) => r.state === 'seasonal_expired').length,
      totalReady: rows.reduce((sum, r) => sum + r.readyProducts, 0),
      totalActive: rows.reduce((sum, r) => sum + r.activeProducts, 0),
    },
  })
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const action = String(body?.action || 'refresh')

  if (action === 'refresh') {
    // Full pipeline: regenerate underlying intelligence aggregation, then lifecycle.
    await refreshSourceIntelligenceState({ applyScores: false }).catch(() => null)
    const result = await refreshNicheLifecycle({ autoPauseExpired: body?.autoPause === true })
    return apiOk({
      ok: true,
      pausedSeasonalNiches: result.pausedSeasonalNiches,
      niches: result.rows.length,
    })
  }

  if (action === 'pause' || action === 'resume') {
    const niche = String(body?.niche || '').trim()
    if (!niche) return apiError('Niche is required.', { status: 400, code: 'NICHE_REQUIRED' })
    await setCustomSourceNicheActive(niche, action === 'resume')
    return apiOk({ ok: true, niche, active: action === 'resume' })
  }

  return apiError('Unknown action.', { status: 400, code: 'UNKNOWN_ACTION' })
}
