import { ensureAutoListingTables } from '@/lib/auto-listing/db'
import type { ScoredCandidate } from '@/lib/auto-listing/types'
import { queryRows, sql } from '@/lib/db'

export async function getQueueStats(userId: string | number) {
  await ensureAutoListingTables()
  const rows = await queryRows<{ status: string; count: number }>`
    SELECT status, COUNT(*)::int AS count
    FROM auto_listing_queue
    WHERE user_id = ${userId}
    GROUP BY status
  `.catch(() => [])

  const map = new Map(rows.map((r) => [r.status, r.count]))
  return {
    queued: map.get('queued') || 0,
    processing: map.get('processing') || 0,
    retry: map.get('retry') || 0,
    failed: map.get('failed') || 0,
    completed: map.get('completed') || 0,
  }
}

export async function countPostedToday(userId: string | number) {
  await ensureAutoListingTables()
  const rows = await queryRows<{ count: number }>`
    SELECT COUNT(*)::int AS count
    FROM auto_listing_queue
    WHERE user_id = ${userId}
      AND status = 'completed'
      AND listed_at >= date_trunc('day', NOW())
  `.catch(() => [])
  return rows[0]?.count || 0
}

export async function enqueueCandidates(userId: string | number, accountId: number | null, candidates: ScoredCandidate[], scheduleAt: (idx: number) => Date) {
  await ensureAutoListingTables()
  if (candidates.length === 0) return 0

  // Insert ignoring duplicates by active status states.
  let inserted = 0
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]
    const at = scheduleAt(i).toISOString()
    const res = await sql`
      INSERT INTO auto_listing_queue (
        user_id, account_id, asin, source_niche, category_id,
        score, score_breakdown, selected_reason, status, scheduled_at, attempts, updated_at
      )
      VALUES (
        ${userId}, ${accountId}, ${c.asin}, ${c.sourceNiche}, ${c.categoryId || null},
        ${c.score}, ${JSON.stringify(c.scoreBreakdown)}, ${c.selectedReason}, 'queued', ${at}, 0, NOW()
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `.catch(() => [])
    if (Array.isArray(res) && res.length > 0) inserted += 1
  }

  return inserted
}

// Maximum age before a queued job is considered stale. Beyond this window the source
// pool data the job was scored against has likely drifted (ASIN cross-mapped to a new
// product on Amazon, price/availability moved) and listing it produces ASIN_MISMATCH or
// PRODUCT_UNAVAILABLE failures. Auto-expire instead of letting them keep retrying.
const QUEUE_ENTRY_TTL_HOURS = 24

export async function expireStaleQueueEntries(userId: string | number) {
  await ensureAutoListingTables()
  const rows = await queryRows<{ id: string }>`
    UPDATE auto_listing_queue
    SET status = 'failed',
        last_error = ${`expired: queued longer than ${QUEUE_ENTRY_TTL_HOURS}h — source data likely drifted`},
        updated_at = NOW()
    WHERE user_id = ${userId}
      AND status IN ('queued','retry')
      AND created_at < NOW() - (${QUEUE_ENTRY_TTL_HOURS} || ' hours')::interval
    RETURNING id
  `.catch(() => [])
  return rows.length
}

export async function acquireNextDueJob(userId: string | number) {
  await ensureAutoListingTables()
  // Sweep stale entries first so they don't get re-attempted and don't hold the score-DESC slot.
  await expireStaleQueueEntries(userId)
  const rows = await queryRows<{
    id: string
    asin: string
    account_id: number | null
    score: string | number
    source_niche: string | null
    category_id: string | null
    attempts: number
  }>`
    WITH next AS (
      SELECT id
      FROM auto_listing_queue
      WHERE user_id = ${userId}
        AND status IN ('queued','retry')
        AND (scheduled_at IS NULL OR scheduled_at <= NOW())
        AND created_at > NOW() - (${QUEUE_ENTRY_TTL_HOURS} || ' hours')::interval
      ORDER BY score DESC, scheduled_at ASC NULLS FIRST, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE auto_listing_queue q
    SET status = 'processing', attempts = q.attempts + 1, updated_at = NOW()
    FROM next
    WHERE q.id = next.id
    RETURNING q.id, q.asin, q.account_id, q.score, q.source_niche, q.category_id, q.attempts
  `.catch(() => [])

  return rows[0] || null
}

export async function markCompleted(queueId: string | number, listingId: string) {
  await ensureAutoListingTables()
  await sql`
    UPDATE auto_listing_queue
    SET status = 'completed', ebay_listing_id = ${listingId}, listed_at = NOW(), updated_at = NOW(), last_error = NULL
    WHERE id = ${queueId}
  `.catch(() => {})
}

export async function markFailed(queueId: string | number, message: string, retryAt?: Date | null) {
  await ensureAutoListingTables()
  if (retryAt) {
    await sql`
      UPDATE auto_listing_queue
      SET status = 'retry', last_error = ${message}, scheduled_at = ${retryAt.toISOString()}, updated_at = NOW()
      WHERE id = ${queueId}
    `.catch(() => {})
    return
  }
  await sql`
    UPDATE auto_listing_queue
    SET status = 'failed', last_error = ${message}, updated_at = NOW()
    WHERE id = ${queueId}
  `.catch(() => {})
}

