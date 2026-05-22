// Diagnostic: what's the format mismatch causing 100% asin_not_found skips?
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
  // What user_id types look like
  listed_asins_sample: `
    SELECT user_id, asin, ebay_listing_id, listed_at::date AS listed_date
    FROM listed_asins WHERE ended_at IS NULL ORDER BY listed_at DESC LIMIT 10`,

  // What did fulfillment agent receive from eBay?
  fulfillment_tracker_sample: `
    SELECT user_id, order_id, legacy_item_id, asin, staged, skip_reason, created_at::date AS d
    FROM fulfillment_agent_tracker
    ORDER BY created_at DESC LIMIT 10`,

  // The smoking gun: do the IDs actually match if we ignore user_id?
  cross_match_attempt: `
    SELECT
      fat.user_id::text AS fat_user_id,
      la.user_id::text  AS la_user_id,
      fat.legacy_item_id,
      la.ebay_listing_id,
      la.asin AS la_asin,
      fat.asin AS fat_asin
    FROM fulfillment_agent_tracker fat
    LEFT JOIN listed_asins la ON la.ebay_listing_id = fat.legacy_item_id
    ORDER BY fat.created_at DESC LIMIT 10`,

  // Column type check
  column_types: `
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE (table_name = 'listed_asins' AND column_name IN ('user_id', 'ebay_listing_id'))
       OR (table_name = 'fulfillment_agent_tracker' AND column_name IN ('user_id', 'legacy_item_id'))
    ORDER BY table_name, column_name`,
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
