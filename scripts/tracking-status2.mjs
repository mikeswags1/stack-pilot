import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)

const r = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE sold_at IS NOT NULL)::int total_with_sales_anywhere,
    COUNT(*) FILTER (WHERE sold_at IS NOT NULL AND ended_at IS NULL)::int sold_still_active,
    COUNT(*) FILTER (WHERE sold_at IS NOT NULL AND ended_at IS NOT NULL)::int sold_then_ended,
    COALESCE(SUM(quantity_sold), 0)::int total_units,
    COALESCE(SUM(realized_profit), 0)::numeric(10,2) total_profit
  FROM listed_asins`)
console.log('Across ALL listed_asins (active + ended):')
console.log(JSON.stringify(r[0], null, 2))

const recent = await sql(`
  SELECT ebay_listing_id, LEFT(title,55) title, sold_at, sale_price, quantity_sold, realized_profit, ended_at IS NOT NULL AS is_ended
  FROM listed_asins WHERE sold_at IS NOT NULL ORDER BY sold_at DESC LIMIT 12`)
console.log(`\nRecent sales (top 12):`)
for (const r of recent) {
  console.log(`  ${r.ebay_listing_id} | sold ${new Date(r.sold_at).toISOString().slice(0,10)} | $${r.sale_price} × ${r.quantity_sold} | profit $${r.realized_profit} | ${r.is_ended ? 'ENDED' : 'still active'} | ${r.title}`)
}

// Check if hit_count exists on any listing ever
const hits = await sql(`
  SELECT COUNT(*) FILTER (WHERE hit_count IS NULL)::int null_hits,
         COUNT(*) FILTER (WHERE hit_count = 0)::int zero_hits,
         COUNT(*) FILTER (WHERE hit_count > 0)::int positive_hits,
         MAX(hit_count) max_hits
  FROM listed_asins WHERE ended_at IS NULL`)
console.log('\nhit_count distribution on active listings:')
console.log(JSON.stringify(hits[0], null, 2))
