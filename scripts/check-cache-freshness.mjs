// Check if the "available=TRUE" cache for deactivated products is fresh enough to trust
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

const niches = ['Kitchen Gadgets', 'Summer Outdoor Gear', 'Travel Accessories', 'Golf Accessories']

for (const niche of niches) {
  const r = await sql(`
    SELECT
      COUNT(*) FILTER (WHERE apc.updated_at > NOW() - INTERVAL '6 hours')::int AS cached_last_6h,
      COUNT(*) FILTER (WHERE apc.updated_at > NOW() - INTERVAL '24 hours')::int AS cached_last_24h,
      COUNT(*) FILTER (WHERE apc.updated_at > NOW() - INTERVAL '7 days')::int AS cached_last_7d,
      COUNT(*)::int AS total
    FROM product_source_items psi
    JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.source_niche = $1
      AND psi.active = FALSE
      AND apc.available = TRUE
      AND jsonb_array_length(apc.images) >= 2
      AND psi.profit >= 4 AND psi.roi >= 25
      AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
  `, [niche])
  console.log(`${niche.padEnd(28)} recoverable=${r[0].total}  fresh<6h=${r[0].cached_last_6h}  <24h=${r[0].cached_last_24h}  <7d=${r[0].cached_last_7d}`)
}
