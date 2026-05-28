// Apply the EXACT product-finder "list ready" filter to see what's left
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Funnel: each step shows how many products survive the next filter
console.log('LISTING FUNNEL — what is killing the "list ready" count?\n')

const r = await sql(`
  WITH active AS (
    SELECT psi.*, apc.images AS cached_images, apc.available AS cached_avail
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE
  )
  SELECT
    COUNT(*)::int AS step_0_all_active,

    COUNT(*) FILTER (WHERE
      profit >= 4 AND roi >= 25 AND risk <> 'HIGH'
      AND image_url IS NOT NULL AND image_url <> ''
      AND COALESCE(source_quality, 'candidate') <> 'reject'
      AND COALESCE(cached_avail, TRUE) <> FALSE
    )::int AS step_1_engine_filter_4_25,

    COUNT(*) FILTER (WHERE
      profit >= 9 AND roi >= 32 AND risk <> 'HIGH'
      AND image_url IS NOT NULL AND image_url <> ''
      AND COALESCE(source_quality, 'candidate') <> 'reject'
      AND COALESCE(cached_avail, TRUE) <> FALSE
    )::int AS step_2_finder_stock_9_32,

    COUNT(*) FILTER (WHERE
      profit >= 9 AND roi >= 32 AND risk <> 'HIGH'
      AND image_url IS NOT NULL AND image_url <> ''
      AND COALESCE(source_quality, 'candidate') <> 'reject'
      AND COALESCE(cached_avail, TRUE) <> FALSE
      AND COALESCE(source_quality, '') <> 'needs_images'
    )::int AS step_3_not_needs_images,

    COUNT(*) FILTER (WHERE
      profit >= 9 AND roi >= 32 AND risk <> 'HIGH'
      AND image_url IS NOT NULL AND image_url <> ''
      AND COALESCE(source_quality, 'candidate') <> 'reject'
      AND COALESCE(cached_avail, TRUE) <> FALSE
      AND COALESCE(source_quality, '') <> 'needs_images'
      AND jsonb_typeof(cached_images) = 'array'
      AND jsonb_array_length(cached_images) >= 2
    )::int AS step_4_has_2_plus_cached_images,

    COUNT(*) FILTER (WHERE
      profit >= 9 AND roi >= 32 AND risk <> 'HIGH'
      AND image_url IS NOT NULL AND image_url <> ''
      AND COALESCE(source_quality, 'candidate') <> 'reject'
      AND COALESCE(cached_avail, TRUE) <> FALSE
      AND COALESCE(source_quality, '') <> 'needs_images'
      AND jsonb_typeof(cached_images) = 'array'
      AND jsonb_array_length(cached_images) >= 2
      AND COALESCE(rating::numeric, 0) >= 3.8
    )::int AS step_5_rating_38_plus,

    COUNT(*) FILTER (WHERE
      profit >= 9 AND roi >= 32 AND risk <> 'HIGH'
      AND image_url IS NOT NULL AND image_url <> ''
      AND COALESCE(source_quality, 'candidate') <> 'reject'
      AND COALESCE(cached_avail, TRUE) <> FALSE
      AND COALESCE(source_quality, '') <> 'needs_images'
      AND jsonb_typeof(cached_images) = 'array'
      AND jsonb_array_length(cached_images) >= 2
      AND COALESCE(rating::numeric, 0) >= 3.8
      AND COALESCE(review_count::int, 0) >= 20
    )::int AS step_6_reviews_20_plus
  FROM active
`)
console.log(JSON.stringify(r[0], null, 2))

// Per-niche breakdown with the FINAL filter
console.log('\nPer-niche FINAL listable count (with all product-finder filters):')
const perNiche = await sql(`
  SELECT psi.source_niche AS niche,
    COUNT(*) FILTER (WHERE psi.active = TRUE)::int AS active,
    COUNT(*) FILTER (WHERE
      psi.active = TRUE
      AND psi.profit >= 9 AND psi.roi >= 32 AND psi.risk <> 'HIGH'
      AND psi.image_url IS NOT NULL AND psi.image_url <> ''
      AND COALESCE(psi.source_quality, 'candidate') NOT IN ('reject', 'needs_images')
      AND COALESCE(apc.available, TRUE) <> FALSE
      AND jsonb_typeof(apc.images) = 'array'
      AND jsonb_array_length(apc.images) >= 2
      AND COALESCE(psi.rating::numeric, 0) >= 3.8
      AND COALESCE(psi.review_count::int, 0) >= 20
    )::int AS list_ready
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
  GROUP BY psi.source_niche
  ORDER BY list_ready DESC LIMIT 25
`)
for (const r of perNiche) console.log(`  ${(r.niche || '(none)').padEnd(30)} active=${String(r.active).padStart(4)}  list_ready=${r.list_ready}`)

// How many cached_images are NULL/empty?
console.log('\nCached image coverage:')
const cachedCov = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE apc.asin IS NULL)::int AS no_cache_at_all,
    COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND (apc.images IS NULL OR jsonb_typeof(apc.images) <> 'array'))::int AS cache_but_no_images_arr,
    COUNT(*) FILTER (WHERE jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) < 2)::int AS cache_with_1_image,
    COUNT(*) FILTER (WHERE jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2 AND jsonb_array_length(apc.images) < 4)::int AS cache_with_2_3,
    COUNT(*) FILTER (WHERE jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 4)::int AS cache_with_4_plus
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
`)
console.log(JSON.stringify(cachedCov[0], null, 2))
