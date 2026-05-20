import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { after } from 'next/server'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export const maxDuration = 300

/**
 * POST /api/admin/restock-all
 * Triggers a full sequential restock of all niches in the background.
 * Fires four parallel cron calls:
 *   1. sourceOnly – pool maintenance / price sync
 *   2. full – baseline restock all niches to 200 products
 *   3. stockWeak batch=12 – top up every weak niche
 *   4. backgroundCatalog batch=6 – deep crawl 6 niches to 780 products
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  const cronSecret = process.env.CRON_SECRET || ''
  const host = new URL(req.url).origin
  const headers: Record<string, string> = cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}

  const endpoints = [
    `${host}/api/cron/refresh-products?sourceOnly=1&autopilot=1`,
    `${host}/api/cron/refresh-products?stockWeak=1&wait=1&batch=12`,
    `${host}/api/cron/refresh-products?backgroundCatalog=1&wait=1&batch=6`,
    `${host}/api/cron/refresh-products?full=1&wait=1`,
  ]

  // Fire the first one immediately and return — the rest run in background
  // so the admin UI gets a fast response instead of timing out.
  const firstResult = await fetch(endpoints[0], {
    headers,
    signal: AbortSignal.timeout(25000),
  })
    .then((r) => r.json())
    .catch(() => ({ error: 'sourceOnly failed' }))

  after(async () => {
    for (const url of endpoints.slice(1)) {
      await fetch(url, {
        headers,
        signal: AbortSignal.timeout(285000),
      }).catch(() => null)
      // Small gap between heavy cron calls to avoid DB contention
      await new Promise((r) => setTimeout(r, 3000))
    }
  })

  return apiOk({
    triggered: true,
    message: 'Restocking all niches. sourceOnly ran immediately; full, stockWeak batch=12, and backgroundCatalog batch=6 are running in the background. Check Admin → Source Engine in ~5 minutes.',
    firstResult,
    queued: endpoints.slice(1),
  })
}
