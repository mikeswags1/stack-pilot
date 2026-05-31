import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)

// 1) What has the scout actually produced?
const scoutProducts = await sql(`
  SELECT COUNT(*)::int total,
         COUNT(*) FILTER (WHERE active)::int active,
         COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '24 hours')::int last_24h,
         COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '4 hours')::int last_4h,
         MAX(first_seen_at) AS latest
  FROM product_source_items
  WHERE source_provider = 'demand-scout'`)
console.log('=== 1. SCOUT OUTPUT ===')
console.log(`Total scout products ever: ${scoutProducts[0].total}`)
console.log(`Active scout products now: ${scoutProducts[0].active}`)
console.log(`Added in last 24h: ${scoutProducts[0].last_24h}`)
console.log(`Added in last 4h (after morning fix): ${scoutProducts[0].last_4h}`)
console.log(`Most recent scout discovery: ${scoutProducts[0].latest || '(none)'}`)

// 2) Cron run cadence — did the scout cron actually fire?
const cursor = await sql(`SELECT * FROM demand_scout_state WHERE id = 1`).catch(() => [])
console.log(`\n=== 2. SCOUT STATE ===`)
console.log(JSON.stringify(cursor[0] || 'no row', null, 2))

// 3) Competition data quality — what's the distribution?
const compDist = await sql(`
  WITH a AS (SELECT ebay_competitor_count c, ebay_competitor_min_price p FROM product_source_items WHERE active)
  SELECT
    COUNT(*) FILTER (WHERE c IS NULL)::int unknown,
    COUNT(*) FILTER (WHERE c = 0)::int zero,
    COUNT(*) FILTER (WHERE c BETWEEN 1 AND 10)::int sweet_spot,
    COUNT(*) FILTER (WHERE c BETWEEN 11 AND 50)::int moderate,
    COUNT(*) FILTER (WHERE c BETWEEN 51 AND 200)::int saturated,
    COUNT(*) FILTER (WHERE c > 200)::int crushed,
    COUNT(*) FILTER (WHERE p IS NOT NULL)::int has_min_price,
    COUNT(*)::int total
  FROM a`)
const cd = compDist[0]
console.log('\n=== 3. COMPETITION DATA QUALITY ===')
console.log(`Total active products with competition check: ${cd.total - cd.unknown} / ${cd.total} (${Math.round((cd.total-cd.unknown)*100/cd.total)}%)`)
console.log(`  0 competitors (likely scrape failure / odd title): ${cd.zero}`)
console.log(`  1-10 (true sweet spot): ${cd.sweet_spot}`)
console.log(`  11-50 (moderate, list-ready): ${cd.moderate}`)
console.log(`  51-200 (saturated, gated out): ${cd.saturated}`)
console.log(`  200+ (crushed, gated out): ${cd.crushed}`)
console.log(`  With min-price data: ${cd.has_min_price}`)

// 4) Spot-check: 5 random products' raw signals
const samples = await sql(`
  SELECT psi.asin, LEFT(psi.title, 50) title, psi.amazon_price, psi.ebay_price,
         psi.ebay_competitor_count, psi.ebay_competitor_min_price
  FROM product_source_items psi
  WHERE psi.active AND psi.ebay_competitor_count IS NOT NULL
  ORDER BY RANDOM() LIMIT 8`)
console.log('\n=== 4. SAMPLE OF SCORED PRODUCTS ===')
for (const s of samples) {
  console.log(`  ${s.asin} | Az $${s.amazon_price} → eBay $${s.ebay_price} | ${s.ebay_competitor_count} comp @ min $${s.ebay_competitor_min_price || '?'} | ${s.title}`)
}

// 5) Is the system using the demand-scout products downstream?
const ready = await sql(`
  SELECT psi.source_provider, COUNT(*)::int n
  FROM product_source_items psi
  JOIN amazon_product_cache apc ON UPPER(apc.asin)=UPPER(psi.asin)
  WHERE psi.active AND psi.profit>=4 AND psi.roi>=25 AND psi.risk<>'HIGH'
    AND psi.image_url<>'' AND COALESCE(psi.source_quality,'candidate') NOT IN ('reject','needs_images','stale')
    AND COALESCE(apc.available,TRUE)<>FALSE AND jsonb_array_length(apc.images)>=2
    AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin)=UPPER(psi.asin) AND la.ended_at IS NULL)
  GROUP BY 1 ORDER BY 2 DESC`)
console.log('\n=== 5. LIST-READY POOL BY SOURCE ===')
for (const r of ready) console.log(`  ${String(r.source_provider).padEnd(20)} ${r.n} list-ready`)
