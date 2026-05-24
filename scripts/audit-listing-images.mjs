// Audit recent listings to see which are missing images / badge
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Overall image count distribution for recent listings
const dist = await sql(`
  SELECT
    image_count,
    image_quality_warning,
    COUNT(*)::int AS n
  FROM listed_asins
  WHERE ended_at IS NULL AND listed_at > NOW() - INTERVAL '24 hours'
  GROUP BY 1, 2 ORDER BY 1 ASC NULLS FIRST
`)
console.log('Image count distribution (last 24h active listings):')
for (const r of dist) {
  console.log(`  image_count=${r.image_count ?? 'NULL'}  warning=${r.image_quality_warning}  count=${r.n}`)
}

const totals = await sql(`
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE image_quality_warning = TRUE)::int AS with_warning,
    COUNT(*) FILTER (WHERE image_count IS NULL OR image_count < 2)::int AS missing_imgs,
    COUNT(*) FILTER (WHERE image_count >= 4)::int AS full_4_plus,
    COUNT(*) FILTER (WHERE amazon_image_url IS NULL OR amazon_image_url = '')::int AS no_primary_url
  FROM listed_asins
  WHERE ended_at IS NULL AND listed_at > NOW() - INTERVAL '24 hours'
`)
console.log(`\nLast 24h summary:`)
console.log(JSON.stringify(totals[0], null, 2))

// Show a few examples with image_count < 4 or NULL
const samples = await sql(`
  SELECT ebay_listing_id, asin, title, image_count, image_quality_warning, listed_at::text AS at
  FROM listed_asins
  WHERE ended_at IS NULL
    AND listed_at > NOW() - INTERVAL '24 hours'
    AND (image_count IS NULL OR image_count < 4)
  ORDER BY listed_at DESC LIMIT 10
`)
console.log(`\nSample listings with < 4 images or NULL:`)
for (const r of samples) {
  console.log(`  ${r.ebay_listing_id}  imgs=${r.image_count}  warn=${r.image_quality_warning}  ${(r.title || '').slice(0, 80)}`)
}
