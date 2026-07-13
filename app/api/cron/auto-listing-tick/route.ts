import { NextRequest } from 'next/server'
import { apiError, apiOk } from '@/lib/api-response'
import { ensureAutoListingTables } from '@/lib/auto-listing/db'
import { getAutoListingSettings } from '@/lib/auto-listing/settings'
import { getTopAutoListingCandidates } from '@/lib/auto-listing/scoring'
import { acquireNextDueJob, markCompleted, markFailed } from '@/lib/auto-listing/queue'
import { fillQueueIfNeeded, enforceMaxPerHour, canScheduleMoreToday } from '@/lib/auto-listing/scheduler'
import { logAutoListingEvent } from '@/lib/auto-listing/logging'
import { queryRows } from '@/lib/db'

export const maxDuration = 300

function jitterRetryMinutes() {
  return 10 + Math.floor(Math.random() * 25) // 10-35 min
}

async function listOneViaInternal(req: NextRequest, input: { userId: number; accountId: number | null; asin: string; title?: string | null; niche?: string | null; categoryId?: string | null }) {
  const host = req.headers.get('host') || ''
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  const siteUrl = `${proto}://${host}`

  const cronSecret = process.env.CRON_SECRET || ''
  if (!cronSecret) throw new Error('CRON_SECRET not configured')

  // Pull required listing fields from the source pool (trusted mode needs amazonPrice + images/title).
  const poolRows = await queryRows<{
    title: string
    source_niche: string | null
    amazon_price: string | number
    ebay_price: string | number
    image_url: string | null
    raw: Record<string, unknown> | null
    roi: string | number
  }>`
    SELECT title, source_niche, amazon_price, ebay_price, image_url, raw, roi
    FROM product_source_items
    WHERE asin = ${input.asin}
    LIMIT 1
  `.catch(() => [])
  if (!poolRows[0]) throw new Error('Product not found in source pool')

  const raw = poolRows[0].raw || {}
  const images = Array.isArray(raw.images) ? (raw.images as string[]) : []
  const features = Array.isArray(raw.features) ? (raw.features as string[]) : []
  const description = typeof raw.description === 'string' ? raw.description : ''
  const specs = Array.isArray(raw.specs) ? (raw.specs as Array<[string, string]>) : []

  const body = {
    userId: input.userId,
    accountId: input.accountId,
    asin: input.asin,
    title: input.title || poolRows[0].title,
    niche: input.niche || poolRows[0].source_niche,
    amazonPrice: Number(poolRows[0].amazon_price),
    ebayPrice: Number(poolRows[0].ebay_price),
    imageUrl: poolRows[0].image_url || images[0] || null,
    images,
    features,
    description,
    specs,
    trusted: true,
    categoryId: input.categoryId || null,
  }

  const res = await fetch(`${siteUrl}/api/ebay/list-product`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.ok) {
    const msg = json?.error?.message || json?.message || `Listing failed (${res.status})`
    const code = json?.error?.code || json?.code
    const e = new Error(code ? `${code}: ${msg}` : msg)
    ;(e as any).code = code
    throw e
  }
  return json as { ok: true; listingUrl: string; listingId: string }
}

async function processAutoListingUser(req: NextRequest, userId: number): Promise<Record<string, unknown>> {
  const settings = await getAutoListingSettings(userId)
  if (!settings.enabled) return { skipped: 'disabled' }
  if (settings.emergency_stopped) return { skipped: 'emergency_stopped' }
  if (settings.paused) return { skipped: 'paused' }

  // Quota gate — soft-throttle cron when eBay quota is in warn/block range. Manual
  // user listings still proceed (they go through list-product's own gate), but the
  // cron auto-lister stands down to leave room for user-initiated work.
  const { shouldSkipCronListing } = await import('@/lib/quota-tracker')
  if (await shouldSkipCronListing().catch(() => false)) {
    return { skipped: 'ebay_quota_throttled' }
  }

  const accountId = settings.selected_account_id ?? null

  // Lease/lock per user so cron retries do not double-run. NOTE: session advisory
  // locks (pg_try_advisory_lock) are useless over the serverless HTTP driver — the
  // session ends with the statement, releasing the lock instantly. The TTL lock row
  // actually holds across the run.
  const leaseKey = `auto_listing:${userId}`
  const { tryAcquireCronLock, releaseCronLock } = await import('@/lib/cron-lock')
  if (!(await tryAcquireCronLock(leaseKey, 290))) return { skipped: 'locked' }

  const startedAt = Date.now()
  const report: Record<string, unknown> = {}

  try {
    if (settings.cooldown_minutes > 0) {
      const cooldownRows = await queryRows<{ listed_at: string | null }>`
        SELECT MAX(listed_at) AS listed_at
        FROM auto_listing_queue
        WHERE user_id = ${userId} AND status = 'completed'
          AND listed_at >= NOW() - interval '6 hours'
      `.catch(() => [])
      const last = cooldownRows[0]?.listed_at ? new Date(String(cooldownRows[0].listed_at)).getTime() : 0
      if (last && Date.now() - last < settings.cooldown_minutes * 60 * 1000) {
        return { skipped: 'cooldown', ...report }
      }
    }

    const candidates = await getTopAutoListingCandidates(userId, settings, 220)
    report.candidates = candidates.length
    const fill = await fillQueueIfNeeded({ userId, accountId, settings, candidates })
    report.queued = fill.inserted

    // ── BATCH POST ────────────────────────────────────────────────────────────────
    // Drain every job that is DUE this tick. The drip scheduler spaces jobs across the
    // day via scheduled_at, so on a steady state only a handful are due each tick; but
    // when there's a backlog (or a high listings_per_day) this loop lets the autopilot
    // reach hundreds/day instead of the old 1-listing-per-tick ceiling. Bounded by:
    //   • the per-hour cap (enforceMaxPerHour)
    //   • the daily cap (canScheduleMoreToday → listings_per_day)
    //   • a per-tick safety cap (MAX_PER_TICK)
    //   • a wall-clock budget so the serverless function never times out mid-listing
    //   • eBay quota throttling (stop the moment eBay says we're over)
    const BATCH_BUDGET_MS = 240_000
    const MAX_PER_TICK = 40
    let listedCount = 0
    let failedCount = 0
    const failureSamples: string[] = []

    for (let i = 0; i < MAX_PER_TICK; i += 1) {
      if (Date.now() - startedAt > BATCH_BUDGET_MS) { report.stoppedBy = 'time_budget'; break }
      if (!(await canScheduleMoreToday(userId, settings))) { report.stoppedBy = 'daily_cap'; break }
      if (!(await enforceMaxPerHour(userId, settings))) { report.stoppedBy = 'max_per_hour'; break }
      if (await shouldSkipCronListing().catch(() => false)) { report.stoppedBy = 'ebay_quota'; break }

      const job = await acquireNextDueJob(userId)
      if (!job) { report.stoppedBy = report.stoppedBy || 'queue_drained'; break }

      await logAutoListingEvent({
        userId,
        accountId: job.account_id ?? accountId,
        queueId: job.id,
        asin: job.asin,
        eventType: 'processing',
        message: 'Posting listing.',
        data: { score: job.score, attempts: job.attempts },
      })

      try {
        const listed = await listOneViaInternal(req, {
          userId,
          accountId: job.account_id ?? accountId,
          asin: job.asin,
          niche: job.source_niche,
          categoryId: job.category_id,
        })
        await markCompleted(job.id, listed.listingId)
        await logAutoListingEvent({
          userId,
          accountId: job.account_id ?? accountId,
          queueId: job.id,
          asin: job.asin,
          eventType: 'listed',
          message: `Listed successfully (${listed.listingId}).`,
          data: { listingId: listed.listingId, listingUrl: listed.listingUrl },
        })
        listedCount += 1
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        const code = (error as { code?: string })?.code
        const attempts = Number(job.attempts || 0)
        const retryAt = attempts <= 1 ? new Date(Date.now() + jitterRetryMinutes() * 60 * 1000) : null
        await markFailed(job.id, msg.slice(0, 900), retryAt)
        await logAutoListingEvent({
          userId,
          accountId: job.account_id ?? accountId,
          queueId: job.id,
          asin: job.asin,
          eventType: retryAt ? 'retry_scheduled' : 'failed',
          message: msg.slice(0, 400),
          data: { attempts, retryAt: retryAt?.toISOString() || null },
        })
        failedCount += 1
        if (failureSamples.length < 5) failureSamples.push(msg.slice(0, 140))
        // eBay quota errors mean every further call this tick will also fail — stop now.
        if (code === 'EBAY_API_QUOTA_EXCEEDED' || /quota|usage limit/i.test(msg)) { report.stoppedBy = 'ebay_quota'; break }
      }
    }

    report.listed = listedCount
    report.failed = failedCount
    report.processed = listedCount + failedCount
    if (failureSamples.length) report.failureSamples = failureSamples
    report.durationMs = Date.now() - startedAt
    return report
  } finally {
    await releaseCronLock(leaseKey)
  }
}

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

  if (!authed) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  await ensureAutoListingTables()

  const userIdParam = req.nextUrl.searchParams.get('userId')
  if (userIdParam) {
    const userId = Number(userIdParam)
    if (!Number.isFinite(userId)) return apiError('Invalid userId.', { status: 400, code: 'INVALID_USER' })
    return apiOk({ ok: true, userId, ...await processAutoListingUser(req, userId) })
  }

  const limit = Math.max(1, Math.min(Number(req.nextUrl.searchParams.get('limit') || '12') || 12, 40))
  const userRows = await queryRows<{ user_id: number }>`
    SELECT s.user_id
    FROM auto_listing_settings s
    WHERE s.enabled = TRUE
      AND s.paused = FALSE
      AND s.emergency_stopped = FALSE
      AND (
        EXISTS (SELECT 1 FROM ebay_credentials ec WHERE ec.user_id = s.user_id)
        OR EXISTS (SELECT 1 FROM ebay_accounts ea WHERE ea.user_id = s.user_id AND ea.active = TRUE)
      )
    ORDER BY RANDOM()
    LIMIT ${limit}
  `.catch(() => [])

  const startedAt = Date.now()
  const results: Array<{ userId: number; result: Record<string, unknown> }> = []
  for (const row of userRows) {
    if (Date.now() - startedAt > 270_000) break
    const result = await processAutoListingUser(req, Number(row.user_id)).catch((error) => ({
      failed: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
    }))
    results.push({ userId: Number(row.user_id), result })
  }

  return apiOk({
    ok: true,
    mode: 'all-enabled-users',
    usersFound: userRows.length,
    usersProcessed: results.length,
    results,
    durationMs: Date.now() - startedAt,
  })
}
