// Check WHY products are getting deactivated. Are they really unavailable, or false positives?
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// For each of the 4 weak niches: of the products deactivated by cron,
// how many ACTUALLY have cache.available = false vs how many have available = true/null?
const niches = ['Travel Accessories', 'Summer Outdoor Gear', 'Kitchen Gadgets', 'Golf Accessories']

for (const niche of niches) {
  console.log(`\n══════ ${niche} — deactivated products ══════`)
  const r = await sql(`
    SELECT
      COUNT(*) FILTER (WHERE psi.active = FALSE AND apc.asin IS NOT NULL)::int AS deactivated_with_cache,
      COUNT(*) FILTER (WHERE psi.active = FALSE AND apc.available = TRUE)::int AS deactivated_but_available_true,
      COUNT(*) FILTER (WHERE psi.active = FALSE AND apc.available = FALSE)::int AS deactivated_and_available_false,
      COUNT(*) FILTER (WHERE psi.active = FALSE AND apc.available IS NULL AND apc.asin IS NOT NULL)::int AS deactivated_and_available_null,
      COUNT(*) FILTER (WHERE psi.active = FALSE AND apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2 AND COALESCE(apc.available, TRUE) <> FALSE)::int AS recoverable
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.source_niche = $1
  `, [niche])
  const d = r[0]
  console.log(`  Deactivated with cache:           ${d.deactivated_with_cache}`)
  console.log(`    ✗ Genuinely unavailable:        ${d.deactivated_and_available_false}`)
  console.log(`    ✓ Cache says AVAILABLE TRUE:    ${d.deactivated_but_available_true}  ← false-positive deactivation`)
  console.log(`    ? Available unchecked (NULL):   ${d.deactivated_and_available_null}`)
  console.log(`  RECOVERABLE (re-activate?):       ${d.recoverable}`)
}
