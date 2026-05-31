import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)

const breakdown = await sql(`
  SELECT
    COUNT(*)::int total_rows,
    COUNT(*) FILTER (WHERE ebay_listing_id IS NOT NULL AND ebay_listing_id <> '')::int has_ebay_id,
    COUNT(*) FILTER (WHERE ebay_listing_id IS NULL OR ebay_listing_id = '')::int no_ebay_id,
    COUNT(*) FILTER (WHERE ebay_listing_id IS NOT NULL AND ebay_listing_id <> '' AND ended_at IS NULL)::int active_real,
    COUNT(*) FILTER (WHERE ebay_listing_id IS NOT NULL AND ebay_listing_id <> '' AND ended_at IS NOT NULL)::int ended_real,
    COUNT(*) FILTER (WHERE (ebay_listing_id IS NULL OR ebay_listing_id = '') AND ended_at IS NULL)::int reserved_open,
    COUNT(*) FILTER (WHERE (ebay_listing_id IS NULL OR ebay_listing_id = '') AND ended_at IS NOT NULL)::int reserved_released
  FROM listed_asins`)
const b = breakdown[0]
console.log('listed_asins breakdown:')
console.log(`  Total rows:                      ${b.total_rows}`)
console.log(`  With eBay listing ID (real):     ${b.has_ebay_id}`)
console.log(`    └─ Active (not ended):         ${b.active_real}`)
console.log(`    └─ Ended:                      ${b.ended_real}`)
console.log(`  Reservation-only (no eBay ID):   ${b.no_ebay_id}`)
console.log(`    └─ Still open:                 ${b.reserved_open}`)
console.log(`    └─ Released:                   ${b.reserved_released}`)

// Sample the active_real to confirm they look like real listings
const real = await sql(`
  SELECT ebay_listing_id, LEFT(title, 50) title, listed_at, image_count, ebay_price
  FROM listed_asins
  WHERE ebay_listing_id IS NOT NULL AND ebay_listing_id <> '' AND ended_at IS NULL
  ORDER BY listed_at DESC LIMIT 5`)
console.log(`\nSample of "real active" (${real.length} of ${b.active_real}):`)
for (const r of real) console.log(`  ${r.ebay_listing_id} | $${r.ebay_price} | img=${r.image_count} | ${r.title}`)
