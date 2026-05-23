// Count actual niches at each tier
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// All niches with at least 1 active product
const all = await sql(`
  SELECT psi.source_niche AS niche, COUNT(*)::int AS active,
    COUNT(*) FILTER (
      WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2
        AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
        AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
        AND COALESCE(apc.available, TRUE) <> FALSE
        AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
    )::int AS dashboard_visible
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE AND psi.source_niche IS NOT NULL
  GROUP BY 1
  ORDER BY dashboard_visible DESC
`)

const above30 = all.filter((r) => r.dashboard_visible >= 30)
const between15and30 = all.filter((r) => r.dashboard_visible >= 15 && r.dashboard_visible < 30)
const below15 = all.filter((r) => r.dashboard_visible < 15)

console.log(`TOTAL active niches: ${all.length}`)
console.log(`  >= 30 visible:  ${above30.length}`)
console.log(`  15-29 visible:  ${between15and30.length}`)
console.log(`  < 15 visible:   ${below15.length}\n`)

console.log('═ All niches with current count ═')
for (const r of all) {
  const flag = r.dashboard_visible >= 30 ? '✓' : r.dashboard_visible >= 15 ? '○' : '✗'
  console.log(`  ${flag} ${(r.niche || '(none)').padEnd(30)} ${String(r.dashboard_visible).padStart(3)}  (active pool: ${r.active})`)
}
