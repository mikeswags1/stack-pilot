// Diagnose the product pool state
// Run: node scripts/diagnose-pool.mjs
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

// 1. Total pool
const [total] = await sql`SELECT COUNT(*) as n FROM product_source_items WHERE active = TRUE`
console.log('TOTAL ACTIVE POOL:', total.n)

// 2. Per-niche breakdown
const niches = await sql`
  SELECT source_niche, COUNT(*) as total,
    COUNT(*) FILTER (WHERE source_quality = 'ready') as ready,
    COUNT(*) FILTER (WHERE source_quality = 'candidate') as candidate,
    COUNT(*) FILTER (WHERE source_quality = 'reject') as reject,
    COUNT(*) FILTER (WHERE source_quality = 'stale') as stale,
    COUNT(*) FILTER (WHERE source_quality = 'needs_images') as needs_images,
    COUNT(*) FILTER (WHERE image_url IS NOT NULL AND image_url <> '') as has_image,
    COUNT(*) FILTER (WHERE profit >= 3 AND roi >= 25 AND risk <> 'HIGH') as passes_filters
  FROM product_source_items WHERE active = TRUE
  GROUP BY source_niche ORDER BY passes_filters DESC LIMIT 40
`
console.log('\nPER NICHE (top 40 by passes_filters):')
niches.forEach((n) => console.log(JSON.stringify(n)))

// 3. Already listed ASINs
const [listed] = await sql`SELECT COUNT(DISTINCT asin) as n FROM listed_asins WHERE ended_at IS NULL`
console.log('\nALREADY LISTED (active):', listed.n)

// 4. How many pool products are ALREADY LISTED?
const [overlap] = await sql`
  SELECT COUNT(*) as n FROM product_source_items psi
  JOIN listed_asins la ON UPPER(la.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE AND la.ended_at IS NULL
`
console.log('POOL PRODUCTS ALREADY LISTED (overlap):', overlap.n)

// 5. How many pass ALL filters the API uses?
const [valid] = await sql`
  SELECT COUNT(*) as n FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.profit >= 3 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND COALESCE(apc.available, TRUE) <> FALSE
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
`
console.log('TRULY VALID (pass all API filters, not listed):', valid.n)

// 6. Per niche truly valid
const validNiches = await sql`
  SELECT psi.source_niche, COUNT(*) as truly_valid FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.profit >= 3 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND COALESCE(apc.available, TRUE) <> FALSE
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  GROUP BY psi.source_niche ORDER BY truly_valid DESC LIMIT 40
`
console.log('\nTRULY VALID PER NICHE:')
validNiches.forEach((n) => console.log(JSON.stringify(n)))

// 7. How many were excluded by the old 21-day staleness filter?
const [staleExcluded] = await sql`
  SELECT COUNT(*) as n FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.profit >= 3 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND COALESCE(apc.available, TRUE) <> FALSE
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
    AND psi.last_seen_at <= NOW() - INTERVAL '21 days'
`
console.log('\nWOULD HAVE BEEN EXCLUDED BY 21-DAY FILTER:', staleExcluded.n, '(these are now included by the fix)')
