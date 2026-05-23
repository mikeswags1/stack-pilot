// Predict list-ready counts with production gates (>=2 cached images, 4/25 thresholds)
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

console.log('Per-niche LIST-READY count with production gates (cached images >= 2, profit >= 4, roi >= 25):\n')
const r = await sql(`
  SELECT
    COALESCE(psi.source_niche, '(none)') AS niche,
    COUNT(*) FILTER (WHERE psi.active = TRUE)::int AS active,
    COUNT(*) FILTER (
      WHERE psi.active = TRUE
        AND psi.profit >= 4 AND psi.roi >= 25
        AND psi.risk <> 'HIGH'
        AND psi.image_url IS NOT NULL AND psi.image_url <> ''
        AND COALESCE(psi.source_quality, 'candidate') NOT IN ('reject', 'needs_images', 'stale')
        AND COALESCE(apc.available, TRUE) <> FALSE
        AND apc.asin IS NOT NULL
        AND jsonb_typeof(apc.images) = 'array'
        AND jsonb_array_length(apc.images) >= 2
    )::int AS list_ready_new
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  GROUP BY 1
  ORDER BY list_ready_new DESC
  LIMIT 30
`)
let above30 = 0
let above100 = 0
let total = 0
for (const row of r) {
  total += row.list_ready_new
  if (row.list_ready_new >= 30) above30++
  if (row.list_ready_new >= 100) above100++
  const bar = '█'.repeat(Math.min(40, Math.floor(row.list_ready_new / 5)))
  console.log(`  ${row.niche.padEnd(28)} ${String(row.list_ready_new).padStart(4)} ${bar}`)
}
console.log(`\nTotals: ${total} list-ready across ${r.length} niches`)
console.log(`Niches >= 30 ready: ${above30}/${r.length}`)
console.log(`Niches >= 100 ready: ${above100}/${r.length}`)
