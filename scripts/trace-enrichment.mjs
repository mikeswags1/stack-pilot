// Trace where enriched products are being lost in the filter pipeline.
// For each niche, breaks down the funnel from cached to dashboard-visible.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Focus on the worst offenders
const niches = ['Kitchen Gadgets', 'Industrial Equipment', 'Travel Accessories', 'Baby & Kids', 'Office Supplies']

for (const niche of niches) {
  console.log(`\n══════ ${niche} ══════`)
  const r = await sql(`
    SELECT
      -- Stage 0: All active in this niche
      COUNT(*)::int AS active_total,
      -- Stage 1: Has cache row at all
      COUNT(*) FILTER (WHERE apc.asin IS NOT NULL)::int AS has_cache,
      -- Stage 2: Cache has ≥2 images
      COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2)::int AS images_2plus,
      -- Stage 3: Amazon available
      COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2 AND COALESCE(apc.available, TRUE) <> FALSE)::int AS available_ok,
      -- Stage 4: Profit/ROI/Risk OK
      COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2 AND COALESCE(apc.available, TRUE) <> FALSE
                       AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH')::int AS margins_ok,
      -- Stage 5: Not source_quality='reject'
      COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2 AND COALESCE(apc.available, TRUE) <> FALSE
                       AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
                       AND COALESCE(psi.source_quality, 'candidate') <> 'reject')::int AS not_rejected,
      -- Stage 6: Not already listed
      COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND jsonb_array_length(apc.images) >= 2 AND COALESCE(apc.available, TRUE) <> FALSE
                       AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
                       AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
                       AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL))::int AS dashboard_visible,
      -- Diagnostics
      COUNT(*) FILTER (WHERE apc.asin IS NOT NULL AND apc.available = FALSE)::int AS marked_unavailable,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL))::int AS in_listed_asins,
      COUNT(*) FILTER (WHERE psi.source_quality = 'reject')::int AS source_rejected,
      COUNT(*) FILTER (WHERE psi.risk = 'HIGH')::int AS high_risk,
      COUNT(*) FILTER (WHERE psi.profit < 4 OR psi.roi < 25)::int AS bad_margins
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE AND psi.source_niche = $1
  `, [niche])

  const data = r[0]
  console.log(`Funnel:`)
  console.log(`  Active total:           ${data.active_total}`)
  console.log(`  → Has cache:            ${data.has_cache}  (lost ${data.active_total - data.has_cache})`)
  console.log(`  → +Has ≥2 images:       ${data.images_2plus}  (lost ${data.has_cache - data.images_2plus})`)
  console.log(`  → +Amazon available:    ${data.available_ok}  (lost ${data.images_2plus - data.available_ok})  ← marked unavailable: ${data.marked_unavailable}`)
  console.log(`  → +Margins OK:          ${data.margins_ok}  (lost ${data.available_ok - data.margins_ok})`)
  console.log(`  → +Not rejected:        ${data.not_rejected}  (lost ${data.margins_ok - data.not_rejected})`)
  console.log(`  → +Not already listed:  ${data.dashboard_visible}  (lost ${data.not_rejected - data.dashboard_visible})  ← already listed: ${data.in_listed_asins}`)
  console.log(`\n  DASHBOARD SHOWS: ${data.dashboard_visible}`)
}
