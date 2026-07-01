import type { AutoListingSettings, ScoredCandidate } from '@/lib/auto-listing/types'
import { enqueueCandidates, countPostedToday, getQueueStats } from '@/lib/auto-listing/queue'
import { logAutoListingEvent } from '@/lib/auto-listing/logging'
import { queryRows, sql } from '@/lib/db'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function randInt(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min + 1))
}

export async function canScheduleMoreToday(userId: string | number, settings: AutoListingSettings) {
  const posted = await countPostedToday(userId)
  return posted < settings.listings_per_day
}

export async function computeDailyWindow(userId: string | number) {
  // ALWAYS drip starting from NOW. The old logic pinned the window start to 12:00 UTC,
  // so every morning before noon UTC the autopilot scheduled all jobs for the future and
  // sat completely idle — a dead zone of several hours a day. Starting at `now` removes it.
  const now = new Date()
  // End the day's window at the next 04:00 UTC; remaining listings spread from now to then.
  const end = new Date(now)
  end.setUTCHours(4, 0, 0, 0)
  if (end <= now) end.setUTCDate(end.getUTCDate() + 1)
  // Guarantee at least a 2h spread so a big backlog still drips out gently (no eBay burst).
  if (end.getTime() - now.getTime() < 2 * 60 * 60 * 1000) {
    return { start: now, end: new Date(now.getTime() + 2 * 60 * 60 * 1000) }
  }
  return { start: now, end }
}

export async function enforceMaxPerHour(userId: string | number, settings: AutoListingSettings) {
  // Counts completed in the past hour + processing as “in-flight”.
  const rows = await queryRows<{ count: number }>`
    SELECT COUNT(*)::int AS count
    FROM auto_listing_queue
    WHERE user_id = ${userId}
      AND (
        (status = 'completed' AND listed_at >= NOW() - interval '60 minutes')
        OR status = 'processing'
      )
  `.catch(() => [])
  const n = rows[0]?.count || 0
  return n < settings.max_per_hour
}

export async function fillQueueIfNeeded(input: {
  userId: string | number
  accountId: number | null
  settings: AutoListingSettings
  candidates: ScoredCandidate[]
}) {
  const stats = await getQueueStats(input.userId)
  const backlog = stats.queued + stats.retry + stats.processing

  // Keep a rolling backlog so the scheduler can drip-feed smoothly.
  const targetBacklog = clamp(Math.floor(input.settings.listings_per_day / 3), 30, 220)
  if (backlog >= targetBacklog) return { inserted: 0, backlog }

  const remainingToday = Math.max(0, input.settings.listings_per_day - (await countPostedToday(input.userId)))
  const want = clamp(Math.min(targetBacklog - backlog, remainingToday), 10, 120)
  const pick = input.candidates.slice(0, want)

  const { start, end } = await computeDailyWindow(input.userId)
  const durationMs = Math.max(30 * 60 * 1000, end.getTime() - start.getTime())
  const stepMs = Math.max(input.settings.cooldown_minutes * 60 * 1000, Math.floor(durationMs / Math.max(1, want)))

  const inserted = await enqueueCandidates(input.userId, input.accountId, pick, (idx) => {
    const jitter = randInt(-Math.floor(stepMs * 0.25), Math.floor(stepMs * 0.25))
    const t = start.getTime() + idx * stepMs + jitter
    return new Date(t)
  })

  if (inserted > 0) {
    await logAutoListingEvent({
      userId: input.userId,
      accountId: input.accountId,
      eventType: 'selected',
      message: `Queued ${inserted} products for drip listing.`,
      data: { inserted, targetBacklog },
    })
  }

  return { inserted, backlog: backlog + inserted }
}

export async function pauseAutoListing(userId: string | number, paused: boolean) {
  await sql`
    UPDATE auto_listing_settings
    SET paused = ${paused}, updated_at = NOW()
    WHERE user_id = ${userId}
  `.catch(() => {})
}

export async function emergencyStop(userId: string | number) {
  await sql`
    UPDATE auto_listing_settings
    SET emergency_stopped = TRUE, enabled = FALSE, paused = TRUE, updated_at = NOW()
    WHERE user_id = ${userId}
  `.catch(() => {})

  await sql`
    UPDATE auto_listing_queue
    SET status = 'stopped', updated_at = NOW()
    WHERE user_id = ${userId} AND status IN ('queued','retry','processing')
  `.catch(() => {})
}

