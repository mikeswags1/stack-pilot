// Preview the top 20 products that will be enriched first
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

console.log('==== TOP 20 PRODUCTS RAPIDAPI WILL ENRICH FIRST ====\n')
console.log('(filtered: profit>=$4, roi>=25%, risk<>HIGH, not reject)\n')

const top = await sql(`
  SELECT
    psi.asin,
    ROUND(psi.master_score, 1) AS score,
    ROUND(psi.profit, 2) AS profit,
    ROUND(psi.roi, 1) AS roi,
    psi.risk,
    psi.source_niche,
    LEFT(psi.title, 65) AS title
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND apc.asin IS NULL
    AND psi.profit >= 4
    AND psi.roi >= 25
    AND psi.risk <> 'HIGH'
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
  ORDER BY psi.master_score DESC NULLS LAST, psi.total_score DESC NULLS LAST, psi.last_seen_at DESC
  LIMIT 20
`)

for (const r of top) {
  console.log(`  ${r.asin} | score=${String(r.score).padStart(5)} | $${String(r.profit).padStart(5)} profit | ${String(r.roi).padStart(5)}% ROI | ${r.risk.padEnd(6)} | ${(r.source_niche || '(none)').padEnd(25)} | ${r.title}`)
}

console.log('\n==== ENRICHMENT QUEUE SIZE ====\n')
const total = await sql(`
  SELECT COUNT(*)::int AS n
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND apc.asin IS NULL
    AND psi.profit >= 4
    AND psi.roi >= 25
    AND psi.risk <> 'HIGH'
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
`)
console.log(`Total products eligible for enrichment: ${total[0].n}`)
console.log(`RapidAPI Pro allowance: 10,000/month`)
console.log(`Cost to enrich all: ${total[0].n} calls (well within Pro quota)`)
