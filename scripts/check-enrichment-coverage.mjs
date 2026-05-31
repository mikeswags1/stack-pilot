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
    COUNT(*)::int active_total,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count IS NOT NULL)::int has_count,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_min_price IS NOT NULL)::int has_min_price,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count IS NOT NULL AND psi.ebay_competitor_min_price IS NOT NULL)::int full_data,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count IS NULL)::int still_missing,
    COUNT(*) FILTER (WHERE la.amazon_price IS NOT NULL AND la.amazon_price > 0 AND psi.ebay_competitor_min_price IS NOT NULL)::int simulator_ready
  FROM listed_asins la
  JOIN product_source_items psi ON UPPER(la.asin) = UPPER(psi.asin)
  WHERE la.ended_at IS NULL`)
console.log('Coverage after partial enrichment:')
console.log(`  Active listings (joined with source pool): ${r[0].active_total}`)
console.log(`  Have competitor count:                     ${r[0].has_count}  (${(r[0].has_count*100/r[0].active_total).toFixed(0)}%)`)
console.log(`  Have competitor min-price:                 ${r[0].has_min_price}  (${(r[0].has_min_price*100/r[0].active_total).toFixed(0)}%)`)
console.log(`  Have BOTH (simulator-ready):               ${r[0].simulator_ready}  (${(r[0].simulator_ready*100/r[0].active_total).toFixed(0)}%)`)
console.log(`  Still missing competition data:            ${r[0].still_missing}`)
