// Cron overlap guard. Vercel fires every schedule on the dot, so a slow run and the
// next tick (or two variants of the same route landing on the same minute) execute
// the same work twice. Postgres advisory locks are session-scoped and the serverless
// HTTP driver has no sessions, so this uses an atomic lock row with a TTL instead:
// the claim succeeds only if no unexpired holder exists, all in one statement.

import { queryRows, sql } from '@/lib/db'

let tableReady = false
async function ensureCronLockTable() {
  if (tableReady) return
  await sql`
    CREATE TABLE IF NOT EXISTS cron_locks (
      name TEXT PRIMARY KEY,
      locked_until TIMESTAMPTZ NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  tableReady = true
}

/**
 * Try to claim the named lock for ttlSeconds. Returns true if this caller owns the
 * work, false if an unexpired run already holds it (caller should skip, not wait).
 * Locks self-expire — a crashed run never wedges the schedule for more than the TTL.
 */
export async function tryAcquireCronLock(name: string, ttlSeconds: number): Promise<boolean> {
  await ensureCronLockTable()
  try {
    const rows = await queryRows<{ name: string }>`
      INSERT INTO cron_locks (name, locked_until, claimed_at)
      VALUES (${name}, NOW() + (${ttlSeconds} || ' seconds')::interval, NOW())
      ON CONFLICT (name) DO UPDATE
        SET locked_until = NOW() + (${ttlSeconds} || ' seconds')::interval,
            claimed_at = NOW()
        WHERE cron_locks.locked_until < NOW()
      RETURNING name
    `
    return rows.length > 0
  } catch {
    // Fail-open for locks (unlike quota): a lock outage should degrade to today's
    // behavior (occasional double work), never halt the pipeline entirely.
    return true
  }
}

/** Release early so back-to-back schedules aren't blocked by an already-finished run. */
export async function releaseCronLock(name: string): Promise<void> {
  await sql`
    UPDATE cron_locks SET locked_until = NOW() WHERE name = ${name}
  `.catch(() => {})
}
