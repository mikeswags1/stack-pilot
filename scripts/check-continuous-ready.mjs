// Replicate the EXACT continuous (no-niche) source query WHERE clause and count
// how many rows survive each gate — so we find what's really capping the queue at 14.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

const base = `FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE`

async function count(label, extra) {
  const q = `SELECT COUNT(*)::int n ${base} ${extra}`
  const r = await sql(q)
  console.log(`${label.padEnd(52)} ${r[0].n}`)
  return r[0].n
}

console.log('=== CONTINUOUS QUERY GATE-BY-GATE (no-niche) ===')
await count('active = TRUE', '')
await count('+ profit>=4, roi>=25, risk<>HIGH', `AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'`)
await count('+ has image_url', `AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH' AND psi.image_url IS NOT NULL AND psi.image_url <> ''`)
await count('+ source_quality<>reject', `AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH' AND psi.image_url IS NOT NULL AND psi.image_url <> '' AND COALESCE(psi.source_quality,'candidate') <> 'reject'`)
await count('+ apc.available<>FALSE', `AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH' AND psi.image_url IS NOT NULL AND psi.image_url <> '' AND COALESCE(psi.source_quality,'candidate') <> 'reject' AND COALESCE(apc.available,TRUE) <> FALSE`)
const beforeFulfill = `AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH' AND psi.image_url IS NOT NULL AND psi.image_url <> '' AND COALESCE(psi.source_quality,'candidate') <> 'reject' AND COALESCE(apc.available,TRUE) <> FALSE`
await count('+ FULFILLMENT GATE (fast_fulfillment<>FALSE)', `${beforeFulfill} AND apc.fast_fulfillment IS DISTINCT FROM FALSE AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)`)
const afterFulfill = `${beforeFulfill} AND apc.fast_fulfillment IS DISTINCT FROM FALSE AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)`
await count('+ competitor<=50 & cost ratio', `${afterFulfill} AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50) AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)`)
const withRules = `${afterFulfill} AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50) AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)`
await count('+ enriched cache + 2 images + not listed', `${withRules} AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images)='array' AND jsonb_array_length(apc.images)>=2 AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin)=UPPER(psi.asin) AND la.ended_at IS NULL)`)

console.log('\n=== FULFILLMENT COLUMN BREAKDOWN ===')
const ff = await sql`SELECT
  COUNT(*) FILTER (WHERE fast_fulfillment IS TRUE)::int AS t,
  COUNT(*) FILTER (WHERE fast_fulfillment IS FALSE)::int AS f,
  COUNT(*) FILTER (WHERE fast_fulfillment IS NULL)::int AS n
  FROM amazon_product_cache`
console.log(`amazon_product_cache.fast_fulfillment -> TRUE:${ff[0].t}  FALSE:${ff[0].f}  NULL:${ff[0].n}`)
