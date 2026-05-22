// What does the dashboard ACTUALLY see when it loads a niche?
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Updated thresholds: profit>=4, roi>=25 (matching pool-status)
const updatedFilter = `
  SELECT psi.source_niche AS niche, COUNT(*)::int AS dashboard_visible
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.profit >= 4
    AND psi.roi >= 25
    AND psi.risk <> 'HIGH'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND COALESCE(apc.available, TRUE) <> FALSE
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  GROUP BY psi.source_niche
  ORDER BY dashboard_visible DESC
`

const r = await sql(updatedFilter)
const lt30 = r.filter(row => row.dashboard_visible < 30)
const ge30 = r.filter(row => row.dashboard_visible >= 30)
console.log(`After relaxing to profit>=4, roi>=25 (matching pool-status):`)
console.log(`  ✅ ${ge30.length} niches with ≥30 visible`)
console.log(`  ❌ ${lt30.length} niches still under 30:`)
for (const row of lt30) console.log(`     ${row.niche?.padEnd(28)} ${row.dashboard_visible}`)
