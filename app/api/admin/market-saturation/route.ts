// Phase 3 — Market saturation admin endpoint.
//
// GET  → analytics views (top saturated, healthiest low-comp, margin stability, repricing
//        pressure, supply/demand, biggest dup clusters, concentration, race-to-bottom).
// POST → { action: 'refresh' } recomputes saturation/pressure/dup/quality/niche analytics.

import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { getMarketSaturationAnalytics, refreshMarketSaturation } from '@/lib/market-saturation'

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
  const analytics = await getMarketSaturationAnalytics()
  return apiOk({ generatedAt: new Date().toISOString(), ...analytics })
}

export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  if (String(body?.action || 'refresh') === 'refresh') {
    const result = await refreshMarketSaturation()
    return apiOk({ ok: true, ...result })
  }
  return apiError('Unknown action.', { status: 400, code: 'UNKNOWN_ACTION' })
}
