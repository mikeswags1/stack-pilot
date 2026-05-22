// One-off audit script. Reads .env.local for DATABASE_URL, queries production state.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const envPath = path.resolve(process.cwd(), '.env.local')
const env = Object.fromEntries(
  fs.readFileSync(envPath, 'utf-8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]
    })
)

const sql = neon(env.DATABASE_URL)

const queries = {
  queue_failure_reasons:
    `SELECT LEFT(last_error, 120) AS reason, COUNT(*)::int AS n
     FROM auto_listing_queue
     WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '7 days'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
  fulfillment_skip_reasons:
    `SELECT skip_reason, staged, COUNT(*)::int AS n, MAX(created_at)::text AS last_at
     FROM fulfillment_agent_tracker
     WHERE created_at > NOW() - INTERVAL '7 days'
     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
  recent_autolisting_logs:
    `SELECT event_type, COUNT(*)::int AS n, MAX(created_at)::text AS last_at
     FROM auto_listing_logs
     WHERE created_at > NOW() - INTERVAL '24 hours'
     GROUP BY 1 ORDER BY 2 DESC`,
  recent_listing_failures:
    `SELECT LEFT(message, 200) AS message, COUNT(*)::int AS n
     FROM auto_listing_logs
     WHERE event_type IN ('failed','retry_scheduled') AND created_at > NOW() - INTERVAL '7 days'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  pool_age_distribution:
    `SELECT
       COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '24 hours')::int AS fresh_24h,
       COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '7 days')::int AS fresh_7d,
       COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '30 days')::int AS fresh_30d,
       COUNT(*) FILTER (WHERE last_seen_at <= NOW() - INTERVAL '30 days')::int AS stale_30d_plus
     FROM product_source_items WHERE active = TRUE`,
}

for (const [name, q] of Object.entries(queries)) {
  try {
    const r = await sql(q)
    console.log(`\n=== ${name} ===`)
    console.log(JSON.stringify(r, null, 2))
  } catch (e) {
    console.log(`\n=== ${name} ===\nERROR: ${e.message}`)
  }
}
