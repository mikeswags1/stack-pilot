// Diagnose recent listing failures from auto_listing_logs + auto_listing_queue
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

console.log('═══════════ LAST 2 HOURS — LISTING FAILURES ═══════════\n')
const failures = await sql(`
  SELECT
    LEFT(last_error, 250) AS error,
    COUNT(*)::int AS n,
    MAX(updated_at)::text AS last_at
  FROM auto_listing_queue
  WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '2 hours'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
`)
for (const r of failures) console.log(`  [${r.n}] ${r.last_at?.slice(0, 19)}\n      ${r.error}\n`)

console.log('\n═══════════ ENDED LISTINGS — LAST 24h ═══════════\n')
const ended = await sql(`
  SELECT
    LEFT(amazon_status_reason, 80) AS reason,
    COUNT(*)::int AS n
  FROM listed_asins
  WHERE ended_at IS NOT NULL AND ended_at > NOW() - INTERVAL '24 hours'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
`)
if (ended.length === 0) console.log('  No listings ended in last 24h.')
else for (const r of ended) console.log(`  [${r.n}] reason: ${r.reason || '(none)'}`)

console.log('\n═══════════ REPRICE AGENT — LAST 6 HOURS ═══════════\n')
const reprice = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE success = TRUE)::int AS successes,
    COUNT(*) FILTER (WHERE success = FALSE)::int AS failures,
    MAX(created_at)::text AS last_at
  FROM reprice_agent_log
  WHERE created_at > NOW() - INTERVAL '6 hours'
`)
console.log(`  ${reprice[0].successes} successful reprices, ${reprice[0].failures} failed`)
console.log(`  Last run: ${reprice[0].last_at}`)

console.log('\n═══════════ CRON ACTIVITY — LAST HOUR ═══════════\n')
const crons = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'listed')::int AS listed,
    COUNT(*) FILTER (WHERE event_type = 'failed')::int AS failed_attempts,
    COUNT(*) FILTER (WHERE event_type = 'retry_scheduled')::int AS retries,
    COUNT(*) FILTER (WHERE event_type = 'processing')::int AS processing,
    MAX(created_at)::text AS last_at
  FROM auto_listing_logs
  WHERE created_at > NOW() - INTERVAL '1 hour'
`)
console.log(JSON.stringify(crons[0], null, 2))

console.log('\n═══════════ DAILY LISTING ATTEMPT COUNT ═══════════\n')
const daily = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'listed' AND created_at > NOW() - INTERVAL '24 hours')::int AS listed_24h,
    COUNT(*) FILTER (WHERE event_type = 'failed' AND created_at > NOW() - INTERVAL '24 hours')::int AS failed_24h,
    COUNT(*) FILTER (WHERE event_type = 'processing' AND created_at > NOW() - INTERVAL '24 hours')::int AS attempts_24h
  FROM auto_listing_logs
`)
console.log(JSON.stringify(daily[0], null, 2))
