// Phase 2 — Top performers admin endpoint.
//
// GET  → returns the learning-loop intelligence views (best/worst niches, fastest listings,
//        top products, stale listings, high-refund niches).
// POST → { action: 'refresh' } triggers a full outcome recompute (scoring + sourcing + niche).

import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { getTopPerformers, scoreAllListings, applyPerformanceToSourcing, applyNicheOutcomeWeighting } from '@/lib/performance-scoring'
import { pullSaleOutcomes, recomputeReductionCounts } from '@/lib/listing-outcomes'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) return null
  return session
}

export async function GET(_req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const performers = await getTopPerformers()
  return apiOk({ generatedAt: new Date().toISOString(), ...performers })
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const action = String(body?.action || 'refresh')

  if (action === 'refresh') {
    // Pull fresh sales (cheap), recompute reductions, then re-score the learning loop.
    const sales = await pullSaleOutcomes({ daysBack: 14 }).catch(() => null)
    await recomputeReductionCounts().catch(() => null)
    const scoring = await scoreAllListings({ windowDays: 120 }).catch(() => ({ scored: 0 }))
    await applyPerformanceToSourcing().catch(() => null)
    const niche = await applyNicheOutcomeWeighting().catch(() => ({ nichesUpdated: 0 }))
    return apiOk({ ok: true, sales, scoring, niche })
  }

  return apiError('Unknown action.', { status: 400, code: 'UNKNOWN_ACTION' })
}
