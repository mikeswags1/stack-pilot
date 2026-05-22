// Diagnose the actual state of the pool right now
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

console.log('==== POOL STATE — DIAGNOSTIC ====\n')

// Overall pool/cache size
const overall = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE psi.active = TRUE)::int AS active_pool,
    COUNT(*) FILTER (WHERE psi.active = TRUE AND apc.asin IS NOT NULL)::int AS active_with_cache,
    COUNT(*) FILTER (WHERE psi.active = TRUE AND apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2)::int AS active_with_2plus_images
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
`)
console.log('Pool size:')
console.log(JSON.stringify(overall[0], null, 2))

// All HOT niches: how many fully-list-ready products
console.log('\n==== ENRICHED + LIST-READY PER NICHE (top 20) ====\n')
const audit = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'scripts', 'niche-audit-results.json'), 'utf-8')
)
const hotNiches = audit.hot.map((n) => n.niche)

const perNiche = await sql(`
  SELECT psi.source_niche AS niche,
    COUNT(*)::int AS active,
    COUNT(*) FILTER (WHERE apc.asin IS NOT NULL)::int AS cached,
    COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2)::int AS cached_2plus_imgs,
    COUNT(*) FILTER (
      WHERE apc.asin IS NOT NULL
        AND jsonb_array_length(apc.images) >= 2
        AND psi.profit >= 4 AND psi.roi >= 25
        AND psi.risk <> 'HIGH'
        AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
        AND COALESCE(apc.available, TRUE) <> FALSE
        AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
    )::int AS dashboard_visible
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.source_niche = ANY($1::text[])
  GROUP BY 1
  ORDER BY dashboard_visible DESC
`, [hotNiches])

console.log('Niche'.padEnd(30) + 'Active  Cached  +2imgs  Visible')
for (const r of perNiche) {
  console.log(
    `${(r.niche || '').padEnd(30)}` +
    `${String(r.active).padStart(6)}  ` +
    `${String(r.cached).padStart(6)}  ` +
    `${String(r.cached_2plus_imgs).padStart(6)}  ` +
    `${String(r.dashboard_visible).padStart(7)}`
  )
}
