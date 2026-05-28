// Find cached Amazon products that aren't in the active pool — potentially recoverable
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

console.log('==== ORPHAN CACHE: cached products NOT in active pool ====\n')
const orphans = await sql(`
  SELECT
    COUNT(*)::int AS total_orphans,
    COUNT(*) FILTER (WHERE jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2)::int AS with_2_plus_images,
    COUNT(*) FILTER (WHERE apc.available = TRUE OR apc.available IS NULL)::int AS available_or_unknown,
    COUNT(*) FILTER (WHERE apc.amazon_price > 0)::int AS has_price,
    COUNT(*) FILTER (WHERE apc.title IS NOT NULL AND apc.title <> '')::int AS has_title,
    COUNT(*) FILTER (WHERE
      apc.available <> FALSE
      AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
      AND apc.amazon_price > 0
      AND apc.title IS NOT NULL AND apc.title <> ''
    )::int AS truly_recoverable
  FROM amazon_product_cache apc
  WHERE NOT EXISTS (
    SELECT 1 FROM product_source_items psi
    WHERE UPPER(psi.asin) = UPPER(apc.asin) AND psi.active = TRUE
  )
`)
console.log(JSON.stringify(orphans[0], null, 2))

console.log('\n==== WHY THEY LEFT THE POOL (status of corresponding pool rows) ====\n')
const reasons = await sql(`
  SELECT
    COALESCE(psi.source_quality, '(no pool row)') AS reason,
    psi.active AS pool_active,
    COUNT(*)::int AS n
  FROM amazon_product_cache apc
  LEFT JOIN product_source_items psi ON UPPER(psi.asin) = UPPER(apc.asin)
  WHERE NOT EXISTS (
    SELECT 1 FROM product_source_items psi2
    WHERE UPPER(psi2.asin) = UPPER(apc.asin) AND psi2.active = TRUE
  )
  AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
  AND apc.available <> FALSE
  GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10
`)
for (const r of reasons) console.log(`  ${r.reason.padEnd(20)} | pool_active=${r.pool_active} | ${r.n}`)

console.log('\n==== SAMPLE RECOVERABLE ASINs ====\n')
const sample = await sql(`
  SELECT apc.asin, LEFT(apc.title, 60) AS title_preview, apc.amazon_price,
         jsonb_array_length(apc.images) AS img_count,
         apc.available,
         psi.source_quality, psi.active, psi.source_niche
  FROM amazon_product_cache apc
  LEFT JOIN product_source_items psi ON UPPER(psi.asin) = UPPER(apc.asin)
  WHERE NOT EXISTS (
    SELECT 1 FROM product_source_items psi2
    WHERE UPPER(psi2.asin) = UPPER(apc.asin) AND psi2.active = TRUE
  )
  AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
  AND apc.available <> FALSE
  AND apc.amazon_price > 0
  ORDER BY jsonb_array_length(apc.images) DESC LIMIT 5
`)
for (const r of sample) {
  console.log(`  ${r.asin} | ${r.img_count} imgs | $${r.amazon_price} | sq=${r.source_quality || '(none)'} active=${r.active} niche=${r.source_niche || '(none)'} | ${r.title_preview}`)
}
