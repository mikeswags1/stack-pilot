// Compare user 1 (working) vs user 2 (skipping)
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

const queries = {
  // Schema check: fulfillment_jobs columns
  fulfillment_jobs_columns: `
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'fulfillment_jobs' ORDER BY ordinal_position`,

  // User 1's fulfillment jobs (we know there are 20)
  user1_jobs_recent: `
    SELECT * FROM fulfillment_jobs WHERE user_id = '1' ORDER BY created_at DESC LIMIT 3`,

  // Is user 1 in the fulfillment_agent_tracker at all?
  user1_in_tracker: `
    SELECT COUNT(*) FILTER (WHERE staged = true)::int AS staged,
           COUNT(*) FILTER (WHERE staged = false)::int AS skipped,
           COUNT(*)::int AS total
    FROM fulfillment_agent_tracker WHERE user_id = '1'`,

  // The orphan listings (NULL ebay_listing_id) — these are bugs
  orphan_listings: `
    SELECT user_id, COUNT(*)::int AS n, MIN(listed_at)::date AS first_seen, MAX(listed_at)::date AS last_seen
    FROM listed_asins WHERE ebay_listing_id IS NULL
    GROUP BY user_id ORDER BY n DESC`,

  // What's the typical eBay listing ID prefix per user — sanity check
  listing_id_prefixes_by_user: `
    SELECT user_id, LEFT(ebay_listing_id, 3) AS prefix, COUNT(*)::int AS n
    FROM listed_asins WHERE ebay_listing_id IS NOT NULL
    GROUP BY user_id, LEFT(ebay_listing_id, 3) ORDER BY user_id, n DESC`,
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
