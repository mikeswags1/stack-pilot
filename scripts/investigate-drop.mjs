// Investigate why dashboard counts are dropping despite enrichment
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

const niches = ['Travel Accessories', 'Summer Outdoor Gear', 'Kitchen Gadgets', 'Golf Accessories']

for (const niche of niches) {
  console.log(`\n══════ ${niche} ══════`)

  // Total pool state regardless of active
  const all = await sql(`
    SELECT
      COUNT(*) FILTER (WHERE psi.active = TRUE)::int AS active,
      COUNT(*) FILTER (WHERE psi.active = FALSE)::int AS inactive,
      COUNT(*) FILTER (WHERE psi.active = TRUE AND apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2)::int AS active_enriched,
      COUNT(*) FILTER (WHERE psi.active = FALSE AND apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2)::int AS inactive_but_enriched,
      COUNT(*) FILTER (WHERE psi.active = TRUE AND apc.available = FALSE)::int AS active_but_unavailable,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL))::int AS in_listed_asins
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.source_niche = $1
  `, [niche])
  console.log(`  Active: ${all[0].active}  (inactive: ${all[0].inactive})`)
  console.log(`  Active + enriched ≥2 imgs: ${all[0].active_enriched}`)
  console.log(`  INACTIVE but were enriched: ${all[0].inactive_but_enriched}  ← potentially lost work`)
  console.log(`  Active but Amazon-unavailable: ${all[0].active_but_unavailable}`)
  console.log(`  ASINs in listed_asins (any status): ${all[0].in_listed_asins}`)

  // Recent active changes
  const recent = await sql(`
    SELECT
      COUNT(*) FILTER (WHERE last_intelligence_at > NOW() - INTERVAL '1 hour' AND active = FALSE)::int AS deactivated_last_hour,
      COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '1 hour')::int AS touched_last_hour
    FROM product_source_items
    WHERE source_niche = $1
  `, [niche])
  console.log(`  Deactivated in last hour: ${recent[0].deactivated_last_hour}`)
  console.log(`  Touched in last hour:     ${recent[0].touched_last_hour}`)
}

// Check listed_asins recent activity
console.log(`\n══════ RECENT LISTING ACTIVITY ══════`)
const listings = await sql(`
  SELECT COALESCE(niche, '(none)') AS niche, COUNT(*)::int AS new_listings
  FROM listed_asins
  WHERE listed_at > NOW() - INTERVAL '2 hours' AND ended_at IS NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
`)
if (listings.length === 0) {
  console.log('  No new listings in the past 2 hours.')
} else {
  for (const r of listings) console.log(`  ${r.niche.padEnd(28)} +${r.new_listings} new listings`)
}
