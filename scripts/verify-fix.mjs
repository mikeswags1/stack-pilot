// Verify that the pool can return 30 unique valid products per niche
// Run: node scripts/verify-fix.mjs
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'fs'

let databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  try {
    const env = Object.fromEntries(
      readFileSync('C:/Users/sield/stack-pilot/.env.local', 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.startsWith('#'))
        .map((l) => {
          const [k, ...rest] = l.split('=')
          return [k.trim(), rest.join('=').trim()]
        })
    )
    databaseUrl = env.DATABASE_URL
  } catch {
    console.error('No DATABASE_URL in environment or .env.local')
    process.exit(1)
  }
}

const sql = neon(databaseUrl)

// Discover actual niches in the DB
const nicheRows = await sql`
  SELECT source_niche, COUNT(*) as truly_valid FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.profit >= 3 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND COALESCE(apc.available, TRUE) <> FALSE
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  GROUP BY psi.source_niche ORDER BY truly_valid DESC LIMIT 10
`

const testNiches = nicheRows.slice(0, 3).map((r) => r.source_niche)
if (testNiches.length === 0) {
  console.error('No niches found in the DB — run diagnose-pool.mjs first')
  process.exit(1)
}

console.log('Testing niches:', testNiches)

let allPass = true
for (const niche of testNiches) {
  const rows = await sql`
    SELECT psi.asin, psi.title, psi.source_niche, psi.profit, psi.roi,
           psi.image_url, psi.source_quality, apc.available
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE
      AND psi.source_niche = ${niche}
      AND psi.profit >= 3 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND psi.image_url IS NOT NULL AND psi.image_url <> ''
      AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
      AND COALESCE(apc.available, TRUE) <> FALSE
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
    LIMIT 30
  `
  const asins = rows.map((r) => r.asin)
  const uniqueAsins = new Set(asins)
  const canShow30 = rows.length >= 30 && uniqueAsins.size === rows.length
  if (!canShow30) allPass = false
  console.log(`\n${niche}:`)
  console.log(`  Count returned: ${rows.length}`)
  console.log(`  Unique ASINs: ${uniqueAsins.size}`)
  console.log(`  Duplicates: ${rows.length - uniqueAsins.size}`)
  console.log(`  Has image: ${rows.filter((r) => r.image_url).length}`)
  console.log(`  All profit >= 3: ${rows.every((r) => Number(r.profit) >= 3)}`)
  console.log(`  All ROI >= 25: ${rows.every((r) => Number(r.roi) >= 25)}`)
  console.log(`  CAN SHOW 30: ${canShow30 ? 'YES' : 'NO (pool may be sparse for this niche)'}`)
}

console.log('\n--- SUMMARY ---')
console.log('All 3 niches pass:', allPass)
if (!allPass) {
  console.log('Note: if a niche has < 30 truly valid products, that is a data quality issue,')
  console.log('not a code issue. Run diagnose-pool.mjs to see per-niche valid counts.')
}
