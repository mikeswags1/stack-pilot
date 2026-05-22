// Quick check of cache + list-ready counts after partial enrichment
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

const stats = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE apc.asin IS NOT NULL)::int AS cached_total,
    COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2)::int AS with_2_plus_images,
    COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 4)::int AS with_4_plus_images,
    COUNT(*)::int AS active_pool
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
`)
console.log('Pool cache coverage (active products):')
console.log(JSON.stringify(stats[0], null, 2))

const listReady = await sql(`
  SELECT psi.source_niche, COUNT(*)::int AS list_ready
  FROM product_source_items psi
  JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND psi.image_url <> ''
    AND COALESCE(psi.source_quality, 'candidate') NOT IN ('reject', 'needs_images', 'stale')
    AND COALESCE(apc.available, TRUE) <> FALSE
    AND jsonb_array_length(apc.images) >= 2
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
`)
console.log('\nTop 10 niches by list-ready count (post-test):')
for (const r of listReady) console.log(`  ${(r.source_niche || '(none)').padEnd(28)} ${r.list_ready}`)
