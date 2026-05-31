import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

console.log('=======================================================')
console.log('     LISTING QUALITY AUDIT — HARD NUMBERS')
console.log('=======================================================\n')

// 1. PRICING COMPETITIVENESS
const pricing = await sql(`
  WITH joined AS (
    SELECT la.ebay_price, psi.ebay_competitor_count comp,
           psi.ebay_competitor_min_price comp_min
    FROM listed_asins la
    LEFT JOIN product_source_items psi ON UPPER(psi.asin) = UPPER(la.asin)
    WHERE la.ended_at IS NULL
  )
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (WHERE comp_min IS NULL)::int no_comp_data,
    COUNT(*) FILTER (WHERE comp_min IS NOT NULL AND ebay_price > comp_min * 1.30)::int badly_overpriced,
    COUNT(*) FILTER (WHERE comp_min IS NOT NULL AND ebay_price > comp_min * 1.15 AND ebay_price <= comp_min * 1.30)::int overpriced,
    COUNT(*) FILTER (WHERE comp_min IS NOT NULL AND ebay_price BETWEEN comp_min * 0.95 AND comp_min * 1.15)::int competitive,
    COUNT(*) FILTER (WHERE comp_min IS NOT NULL AND ebay_price < comp_min * 0.95)::int underpriced
  FROM joined
`)
const p = pricing[0]
const knownPriced = p.total - p.no_comp_data
console.log('1. PRICING COMPETITIVENESS (active listings)')
console.log(`   Total active listings:                ${p.total}`)
console.log(`   No competitor data (can't judge):     ${p.no_comp_data}  (${((p.no_comp_data * 100) / p.total).toFixed(0)}%)`)
console.log(`   --- of the ${knownPriced} we CAN judge: ---`)
console.log(`   Badly overpriced (>30% over min):     ${p.badly_overpriced}  (${((p.badly_overpriced * 100) / knownPriced).toFixed(0)}%)`)
console.log(`   Overpriced (15-30% over min):         ${p.overpriced}  (${((p.overpriced * 100) / knownPriced).toFixed(0)}%)`)
console.log(`   Competitive (±15% of min):            ${p.competitive}  (${((p.competitive * 100) / knownPriced).toFixed(0)}%)`)
console.log(`   Underpriced (>5% below min):          ${p.underpriced}  (${((p.underpriced * 100) / knownPriced).toFixed(0)}%)`)

const samples = await sql(`
  SELECT LEFT(la.title, 55) title, la.ebay_price, psi.ebay_competitor_min_price m, psi.ebay_competitor_count c,
         ROUND((la.ebay_price / psi.ebay_competitor_min_price)::numeric, 2) ratio
  FROM listed_asins la
  JOIN product_source_items psi ON UPPER(psi.asin) = UPPER(la.asin)
  WHERE la.ended_at IS NULL AND psi.ebay_competitor_min_price IS NOT NULL
    AND la.ebay_price > psi.ebay_competitor_min_price * 1.30
  ORDER BY (la.ebay_price - psi.ebay_competitor_min_price) DESC LIMIT 8
`)
console.log('\n   Sample of the worst-overpriced (your price vs cheapest competitor):')
for (const r of samples) {
  console.log(`     $${r.ebay_price} vs $${r.m} (${r.ratio}x | ${r.c} sellers) — ${r.title}`)
}

// 2. TITLE QUALITY
const titles = await sql(`
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (WHERE LENGTH(title) < 40)::int short_t,
    COUNT(*) FILTER (WHERE LENGTH(title) BETWEEN 40 AND 80)::int ok_t,
    COUNT(*) FILTER (WHERE LENGTH(title) > 80)::int long_t,
    AVG(LENGTH(title))::int avg_len,
    COUNT(*) FILTER (WHERE title ~ '^[A-Z0-9 ]+$')::int all_caps,
    COUNT(*) FILTER (WHERE LOWER(title) LIKE 'ad %' OR LOWER(title) LIKE 'ad- %' OR LOWER(title) LIKE 'ad-%')::int has_ad_prefix
  FROM listed_asins WHERE ended_at IS NULL
`)
const t = titles[0]
console.log('\n2. TITLE QUALITY (active listings)')
console.log(`   Total:                                ${t.total}`)
console.log(`   Avg length:                           ${t.avg_len} chars (eBay max is 80)`)
console.log(`   Too short (<40 chars):                ${t.short_t}  (${((t.short_t * 100) / t.total).toFixed(0)}%)`)
console.log(`   Good length (40-80):                  ${t.ok_t}  (${((t.ok_t * 100) / t.total).toFixed(0)}%)`)
console.log(`   Over 80 (eBay would truncate):        ${t.long_t}  (${((t.long_t * 100) / t.total).toFixed(0)}%)`)
console.log(`   ALL CAPS (looks scammy):              ${t.all_caps}`)
console.log(`   "Ad ..." prefix (sponsored leak):     ${t.has_ad_prefix}`)

// 3. IMAGE COVERAGE
const images = await sql(`
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (WHERE image_count IS NULL)::int unknown,
    COUNT(*) FILTER (WHERE image_count = 1)::int one,
    COUNT(*) FILTER (WHERE image_count = 2)::int two,
    COUNT(*) FILTER (WHERE image_count = 3)::int three,
    COUNT(*) FILTER (WHERE image_count >= 4)::int four_plus,
    AVG(image_count)::numeric(4,1) avg_images
  FROM listed_asins WHERE ended_at IS NULL
`)
const i = images[0]
console.log('\n3. IMAGE COVERAGE (our DB; eBay-actual was ~5% lower)')
console.log(`   Avg images per listing:               ${i.avg_images}`)
console.log(`   1 image:                              ${i.one}`)
console.log(`   2 images:                             ${i.two}`)
console.log(`   3 images:                             ${i.three}`)
console.log(`   4+ images (target):                   ${i.four_plus}  (${((i.four_plus * 100) / i.total).toFixed(0)}%)`)
console.log(`   Unknown count:                        ${i.unknown}`)

// 4. ITEM-SPECIFICS HEALTH
const specs = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE error_message ILIKE '%item specific%missing%')::int missing_specs,
    COUNT(*) FILTER (WHERE error_message ILIKE '%brand%missing%')::int brand_missing,
    COUNT(*) FILTER (WHERE error_message ILIKE '%size%missing%')::int size_missing,
    COUNT(*) FILTER (WHERE error_message ILIKE '%height%missing%' OR error_message ILIKE '%width%missing%' OR error_message ILIKE '%length%missing%')::int dim_missing,
    COUNT(*) FILTER (WHERE error_message ILIKE '%value%too long%')::int value_too_long
  FROM listing_failure_log WHERE created_at > NOW() - INTERVAL '24 hours'
`)
const s = specs[0]
console.log('\n4. ITEM-SPECIFICS HEALTH (failures in last 24h)')
console.log(`   "Item specific X missing":            ${s.missing_specs}`)
console.log(`     Brand missing:                      ${s.brand_missing}`)
console.log(`     Size/Size Type missing:             ${s.size_missing}`)
console.log(`     Width/Length/Height missing:        ${s.dim_missing}`)
console.log(`   Value too long:                       ${s.value_too_long}`)

// 5. CATEGORY HEALTH
const cats = await sql(`
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (WHERE category_id IS NULL OR category_id = '')::int no_category,
    COUNT(DISTINCT category_id)::int distinct_cats
  FROM listed_asins WHERE ended_at IS NULL
`)
const c = cats[0]
console.log('\n5. CATEGORY HEALTH (active listings)')
console.log(`   Distinct categories used:             ${c.distinct_cats}`)
console.log(`   Missing category (defaulted):         ${c.no_category}`)

// 6. SATURATION OF LIVE LISTINGS
const sat = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count BETWEEN 1 AND 10)::int sweet,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count BETWEEN 11 AND 50)::int moderate,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count BETWEEN 51 AND 200)::int saturated,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count > 200)::int crushed,
    COUNT(*) FILTER (WHERE psi.ebay_competitor_count IS NULL)::int unknown,
    COUNT(*)::int total
  FROM listed_asins la
  LEFT JOIN product_source_items psi ON UPPER(psi.asin) = UPPER(la.asin)
  WHERE la.ended_at IS NULL
`)
const sa = sat[0]
console.log('\n6. SATURATION OF YOUR LIVE LISTINGS')
console.log(`   Total active:                         ${sa.total}`)
console.log(`   1-10 competitors (sweet spot):        ${sa.sweet}  (${((sa.sweet * 100) / sa.total).toFixed(0)}%)`)
console.log(`   11-50 (moderate):                     ${sa.moderate}  (${((sa.moderate * 100) / sa.total).toFixed(0)}%)`)
console.log(`   51-200 (saturated):                   ${sa.saturated}  (${((sa.saturated * 100) / sa.total).toFixed(0)}%)`)
console.log(`   200+ (crushed):                       ${sa.crushed}  (${((sa.crushed * 100) / sa.total).toFixed(0)}%)`)
console.log(`   Unknown:                              ${sa.unknown}  (${((sa.unknown * 100) / sa.total).toFixed(0)}%)`)
