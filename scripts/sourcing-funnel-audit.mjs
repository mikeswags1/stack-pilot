// SOURCING FUNNEL AUDIT — where do products die between discovery and list-ready?
// Measures: (1) daily inflow of new ASINs, (2) gate-by-gate kill counts with
// exclusive attribution, (3) the enrichment backlog, (4) saturation/cost-ratio
// breakdown by niche so we know WHERE to point discovery next.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

console.log('================ 1. DAILY INFLOW (last 14 days) ================')
const inflow = await sql`
  SELECT first_seen_at::date AS day, COUNT(*)::int AS new_asins
  FROM product_source_items
  WHERE first_seen_at > NOW() - INTERVAL '14 days'
  GROUP BY 1 ORDER BY 1 DESC
`.catch(async () => {
  // fall back to created_at / last_seen_at if first_seen_at doesn't exist
  return sql`
    SELECT created_at::date AS day, COUNT(*)::int AS new_asins
    FROM product_source_items
    WHERE created_at > NOW() - INTERVAL '14 days'
    GROUP BY 1 ORDER BY 1 DESC
  `.catch(() => [])
})
if (inflow.length === 0) console.log('  (no inflow timestamps available)')
for (const r of inflow) console.log(`  ${String(r.day).slice(0, 10)}  +${r.new_asins}`)
const totalInflow = inflow.reduce((s, r) => s + r.new_asins, 0)
console.log(`  TOTAL 14d: ${totalInflow}  (~${Math.round(totalInflow / 14)}/day)`)

console.log('\n================ 2. GATE-BY-GATE FUNNEL (active, unlisted) ================')
const funnel = await sql`
  WITH base AS (
    SELECT psi.*, apc.asin AS cache_asin, apc.available AS c_avail, apc.images AS c_images,
           apc.fast_fulfillment AS c_ff, apc.delivery_days_max AS c_ddm
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  )
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE COALESCE(source_quality,'candidate') = 'reject')::int AS rejected,
    COUNT(*) FILTER (WHERE profit < 4 OR roi < 25 OR risk = 'HIGH')::int AS bad_econ,
    COUNT(*) FILTER (WHERE c_avail = FALSE)::int AS unavailable,
    COUNT(*) FILTER (WHERE ebay_competitor_count > 50)::int AS saturated,
    COUNT(*) FILTER (WHERE ebay_competitor_min_price IS NOT NULL AND amazon_price >= ebay_competitor_min_price * 1.65)::int AS cost_ratio_fail,
    COUNT(*) FILTER (WHERE ebay_competitor_count IS NULL)::int AS comp_unenriched,
    COUNT(*) FILTER (WHERE cache_asin IS NULL)::int AS no_cache_row,
    COUNT(*) FILTER (WHERE cache_asin IS NOT NULL AND (jsonb_typeof(c_images) <> 'array' OR jsonb_array_length(c_images) < 2))::int AS too_few_images,
    COUNT(*) FILTER (WHERE c_ff = FALSE OR c_ddm > 8)::int AS slow_fulfillment
  FROM base
`
const f = funnel[0]
console.log(`  Active + unlisted:                ${f.total}`)
console.log(`  — marked reject (source_quality): ${f.rejected}`)
console.log(`  — bad economics (profit/roi/risk):${f.bad_econ}`)
console.log(`  — Amazon unavailable:             ${f.unavailable}`)
console.log(`  — SATURATED (>50 competitors):    ${f.saturated}`)
console.log(`  — COST RATIO fail (>=1.65x):      ${f.cost_ratio_fail}`)
console.log(`  — competitor data NOT enriched:   ${f.comp_unenriched}`)
console.log(`  — NO amazon cache row at all:     ${f.no_cache_row}`)
console.log(`  — cache has <2 images:            ${f.too_few_images}`)
console.log(`  — slow fulfillment:               ${f.slow_fulfillment}`)

console.log('\n================ 3. RESCUE POTENTIAL (enrichment backlog) ================')
const rescue = await sql`
  WITH base AS (
    SELECT psi.*, apc.asin AS cache_asin, apc.images AS c_images
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE
      AND COALESCE(psi.source_quality,'candidate') <> 'reject'
      AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  )
  SELECT
    COUNT(*)::int AS pass_all_market_gates,
    COUNT(*) FILTER (WHERE cache_asin IS NULL)::int AS needs_first_enrich,
    COUNT(*) FILTER (WHERE cache_asin IS NOT NULL AND (jsonb_typeof(c_images) <> 'array' OR jsonb_array_length(c_images) < 2))::int AS needs_image_enrich
  FROM base
`
const r2 = rescue[0]
console.log(`  Pass economics+market gates:      ${r2.pass_all_market_gates}`)
console.log(`  …of those, never enriched:        ${r2.needs_first_enrich}  <- rescuable by enrichment`)
console.log(`  …of those, enriched but <2 imgs:  ${r2.needs_image_enrich}  <- rescuable by re-scrape`)

console.log('\n================ 4. WHERE SATURATION KILLS (top niches) ================')
const nicheKill = await sql`
  SELECT COALESCE(source_niche,'(none)') AS niche,
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE ebay_competitor_count > 50 OR (ebay_competitor_min_price IS NOT NULL AND amazon_price >= ebay_competitor_min_price * 1.65))::int AS killed_by_market,
    COUNT(*) FILTER (WHERE ebay_competitor_count IS NOT NULL AND ebay_competitor_count <= 50 AND (ebay_competitor_min_price IS NULL OR amazon_price < ebay_competitor_min_price * 1.65))::int AS market_ok
  FROM product_source_items
  WHERE active = TRUE
  GROUP BY 1 HAVING COUNT(*) >= 50
  ORDER BY (COUNT(*) FILTER (WHERE ebay_competitor_count IS NOT NULL AND ebay_competitor_count <= 50 AND (ebay_competitor_min_price IS NULL OR amazon_price < ebay_competitor_min_price * 1.65)))::float / NULLIF(COUNT(*),0) DESC
  LIMIT 15
`
console.log('  niche'.padEnd(46) + 'total  killed  survive  survive%')
for (const n of nicheKill) {
  const pct = Math.round((n.market_ok / n.total) * 100)
  console.log(`  ${String(n.niche).slice(0, 42).padEnd(44)} ${String(n.total).padStart(5)} ${String(n.killed_by_market).padStart(7)} ${String(n.market_ok).padStart(8)} ${String(pct).padStart(8)}%`)
}

console.log('\n================ 5. DISCOVERY SOURCE PERFORMANCE ================')
const provider = await sql`
  SELECT COALESCE(source_provider,'(unknown)') AS provider, COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '7 days')::int AS seen_7d
  FROM product_source_items WHERE active = TRUE
  GROUP BY 1 ORDER BY total DESC LIMIT 10
`.catch(() => [])
for (const p of provider) console.log(`  ${String(p.provider).padEnd(24)} total:${String(p.total).padStart(6)}  active7d:${p.seen_7d}`)
