// Phase 3 — Market saturation & inventory quality intelligence.
//
// Evolves sourcing from "what sells" → "what sells profitably and sustainably" by scoring:
//   1) Saturation       — normalize ebay_competitor_count into 0-100 (higher = more crowded)
//   2) Pricing pressure — how often repricers are forced DOWN + ROI collapse (race-to-bottom)
//   3) Duplicate clusters — group near-identical products so we don't flood the pool with variants
//   4) Inventory quality — composite that favors stable margins + low density + healthy engagement
//   5) Category analytics — per-niche saturation / pressure / supply-demand rollups
//   6) Diversity controls — concentration penalties so sourcing spreads across healthy niches
//
// All scoring is pure DB / cheap (no external API calls). It reads the competition counts that
// enrichCompetitionData already populates (via runSourceSelfHealing) and the reprice_agent_log
// + Phase 2 engagement data. Wired into the daily niche-lifecycle cron.

import { queryRows, sql } from '@/lib/db'
import { getMeaningfulTitleWords } from '@/lib/listing-quality'

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v || 0)
  return Number.isFinite(n) ? n : 0
}

// ────────────────────────────── Schema ──────────────────────────────

export async function ensureMarketSaturationColumns() {
  // Product-level
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS saturation_score NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS pricing_pressure_score NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS roi_trend NUMERIC(8,2)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS dup_cluster_id TEXT`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS dup_cluster_size INTEGER NOT NULL DEFAULT 1`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS dup_rank INTEGER NOT NULL DEFAULT 1`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS inventory_quality_score NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS quality_updated_at TIMESTAMPTZ`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_quality_score_idx ON product_source_items (inventory_quality_score DESC NULLS LAST)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_dup_cluster_idx ON product_source_items (dup_cluster_id)`.catch(() => {})

  // Niche-level
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS avg_saturation NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS avg_pricing_pressure NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS avg_inventory_quality NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS concentration_pct NUMERIC(6,4)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS supply_demand_ratio NUMERIC(8,2)`.catch(() => {})
  await sql`ALTER TABLE source_niche_intelligence ADD COLUMN IF NOT EXISTS dup_ratio NUMERIC(6,4)`.catch(() => {})
}

// ────────────────────────────── Step 1: Saturation score ──────────────────────────────
//
// Normalize ebay_competitor_count → 0-100 on a log scale anchored at 1000 competing listings.
//   count=1000 → 100 (extremely saturated), 100 → ~67, 10 → ~33, 1 → 0, NULL → unknown (left null)

export async function computeSaturationScores() {
  await ensureMarketSaturationColumns()
  const result = await sql`
    UPDATE product_source_items
    SET saturation_score = LEAST(100, GREATEST(0,
      ROUND((log(10, GREATEST(ebay_competitor_count, 1)::numeric) / log(10, 1000::numeric)) * 100, 2)
    ))
    WHERE ebay_competitor_count IS NOT NULL
      AND active = TRUE
  `.catch(() => null)
  return { ok: !!result }
}

// ────────────────────────────── Step 2: Pricing pressure ──────────────────────────────
//
// From reprice_agent_log (per ASIN):
//   downward_ratio = downward reprices / total reprices  → repricer being forced down
//   roi_trend      = latest computed ROI − earliest computed ROI (negative = collapsing margin)
// pricing_pressure_score (0-100) blends downward pressure + ROI collapse magnitude.

export async function computePricingPressure() {
  await ensureMarketSaturationColumns()
  const result = await sql`
    WITH reprice_stats AS (
      SELECT
        asin,
        COUNT(*)::int AS total_reprices,
        COUNT(*) FILTER (WHERE new_ebay_price < old_ebay_price)::int AS downward,
        -- ROI at first vs last reprice point, approx (ebay - amazon)/amazon
        (ARRAY_AGG(
            CASE WHEN new_amazon_price > 0 THEN (new_ebay_price - new_amazon_price) / new_amazon_price * 100 ELSE NULL END
            ORDER BY created_at DESC
         ) FILTER (WHERE new_amazon_price > 0))[1] AS latest_roi,
        (ARRAY_AGG(
            CASE WHEN new_amazon_price > 0 THEN (new_ebay_price - new_amazon_price) / new_amazon_price * 100 ELSE NULL END
            ORDER BY created_at ASC
         ) FILTER (WHERE new_amazon_price > 0))[1] AS earliest_roi
      FROM reprice_agent_log
      WHERE success = TRUE
        AND created_at > NOW() - INTERVAL '90 days'
        AND asin IS NOT NULL
      GROUP BY asin
      HAVING COUNT(*) >= 2
    ),
    scored AS (
      SELECT
        asin,
        ROUND(COALESCE(latest_roi - earliest_roi, 0), 2) AS roi_trend,
        LEAST(100, GREATEST(0, ROUND(
          (downward::numeric / GREATEST(total_reprices, 1)) * 60
          + LEAST(40, GREATEST(0, (earliest_roi - latest_roi))) , 2
        ))) AS pressure
      FROM reprice_stats
    )
    UPDATE product_source_items psi
    SET pricing_pressure_score = scored.pressure,
        roi_trend = scored.roi_trend
    FROM scored
    WHERE psi.asin = scored.asin
  `.catch(() => null)
  return { ok: !!result }
}

// ────────────────────────────── Step 3: Duplicate clustering ──────────────────────────────
//
// Signature = the first 5 meaningful title words, sorted + joined. Products sharing a signature
// are near-duplicates (e.g. "Blue Widget Case 3-Pack" vs "Widget Case Blue 3 Pack").
// We rank within each cluster by total_score so sourcing keeps the best and suppresses the rest.

function clusterSignature(title: string): string | null {
  const words = getMeaningfulTitleWords(title)
  if (words.length < 2) return null
  const top = Array.from(new Set(words)).slice(0, 5).sort()
  if (top.length < 2) return null
  return top.join('|')
}

export async function buildDuplicateClusters() {
  await ensureMarketSaturationColumns()

  const rows = await queryRows<{ asin: string; title: string; total_score: string | number }>`
    SELECT asin, title, total_score
    FROM product_source_items
    WHERE active = TRUE
    ORDER BY total_score DESC
  `.catch(() => [])

  // Group by signature
  const clusters = new Map<string, Array<{ asin: string; score: number }>>()
  const singletons: string[] = []
  for (const row of rows) {
    const sig = clusterSignature(row.title)
    if (!sig) { singletons.push(row.asin); continue }
    const arr = clusters.get(sig) || []
    arr.push({ asin: row.asin, score: toNum(row.total_score) })
    clusters.set(sig, arr)
  }

  let clusteredProducts = 0
  let duplicateGroups = 0

  for (const [sig, members] of clusters.entries()) {
    if (members.length <= 1) {
      // Treat as singleton — reset to defaults
      const asin = members[0]?.asin
      if (asin) {
        await sql`
          UPDATE product_source_items
          SET dup_cluster_id = NULL, dup_cluster_size = 1, dup_rank = 1
          WHERE asin = ${asin}
        `.catch(() => {})
      }
      continue
    }
    duplicateGroups++
    // Stable short id from signature
    const clusterId = `c_${Math.abs(hashString(sig)).toString(36)}`
    // members already roughly ordered by score (outer query ORDER BY total_score DESC), but
    // re-sort defensively
    members.sort((a, b) => b.score - a.score)
    for (let rank = 0; rank < members.length; rank++) {
      await sql`
        UPDATE product_source_items
        SET dup_cluster_id = ${clusterId},
            dup_cluster_size = ${members.length},
            dup_rank = ${rank + 1}
        WHERE asin = ${members[rank].asin}
      `.catch(() => {})
      clusteredProducts++
    }
  }

  // Reset singletons (titles too short to cluster) to defaults
  for (const asin of singletons) {
    await sql`
      UPDATE product_source_items
      SET dup_cluster_id = NULL, dup_cluster_size = 1, dup_rank = 1
      WHERE asin = ${asin} AND dup_cluster_size <> 1
    `.catch(() => {})
  }

  return { duplicateGroups, clusteredProducts, totalProducts: rows.length }
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return hash
}

// ────────────────────────────── Step 4: Inventory quality ──────────────────────────────
//
// Composite 0-100 favoring stable margins + low density + healthy engagement, penalizing
// ultra-low margin / hyper-saturated / heavily-duplicated products.

export async function computeInventoryQuality() {
  await ensureMarketSaturationColumns()
  const result = await sql`
    WITH engagement AS (
      SELECT asin,
             AVG(watch_count) AS avg_watch,
             MAX(CASE WHEN sold_at IS NOT NULL THEN 1 ELSE 0 END) AS ever_sold
      FROM listed_asins
      WHERE asin IS NOT NULL
      GROUP BY asin
    )
    UPDATE product_source_items psi
    SET inventory_quality_score = LEAST(100, GREATEST(0,
          LEAST(psi.roi / 60.0, 1) * 28
        + LEAST(psi.profit / 15.0, 1) * 12
        + (100 - COALESCE(psi.saturation_score, 50)) / 100.0 * 25
        + (100 - COALESCE(psi.pricing_pressure_score, 0)) / 100.0 * 20
        + COALESCE(LEAST(e.avg_watch / 8.0, 1) * 15, 7.5)
        - (CASE WHEN psi.roi < 25 OR psi.profit < 4 THEN 18 ELSE 0 END)
        - (CASE WHEN COALESCE(psi.saturation_score, 0) > 85 THEN 10 ELSE 0 END)
        - (CASE WHEN COALESCE(psi.dup_cluster_size, 1) > 3 THEN 8 ELSE 0 END)
        )),
        quality_updated_at = NOW()
    FROM (SELECT psi2.asin FROM product_source_items psi2 WHERE psi2.active = TRUE) act
    LEFT JOIN engagement e ON e.asin = act.asin
    WHERE psi.asin = act.asin
  `.catch(() => null)
  return { ok: !!result }
}

// ────────────────────────────── Step 5: Niche analytics + diversity ──────────────────────────────

export async function computeNicheSaturationAnalytics() {
  await ensureMarketSaturationColumns()

  // Total active pool for concentration math
  const totalRows = await queryRows<{ total: string | number }>`
    SELECT COUNT(*)::int AS total FROM product_source_items WHERE active = TRUE
  `.catch(() => [])
  const totalActive = Math.max(1, toNum(totalRows[0]?.total))

  const result = await sql`
    WITH niche_agg AS (
      SELECT
        COALESCE(NULLIF(source_niche, ''), 'Unassigned') AS niche,
        COUNT(*)::int AS active_products,
        ROUND(AVG(saturation_score), 2) AS avg_saturation,
        ROUND(AVG(pricing_pressure_score), 2) AS avg_pricing_pressure,
        ROUND(AVG(inventory_quality_score), 2) AS avg_inventory_quality,
        ROUND(
          COUNT(*) FILTER (WHERE dup_cluster_size > 1)::numeric / GREATEST(COUNT(*), 1), 4
        ) AS dup_ratio
      FROM product_source_items
      WHERE active = TRUE
      GROUP BY COALESCE(NULLIF(source_niche, ''), 'Unassigned')
    )
    UPDATE source_niche_intelligence sni
    SET avg_saturation = na.avg_saturation,
        avg_pricing_pressure = na.avg_pricing_pressure,
        avg_inventory_quality = na.avg_inventory_quality,
        dup_ratio = na.dup_ratio,
        concentration_pct = ROUND(na.active_products::numeric / ${totalActive}, 4),
        supply_demand_ratio = ROUND(
          na.active_products::numeric / GREATEST(COALESCE(sni.sold_30d, 0), 1), 2
        ),
        updated_at = NOW()
    FROM niche_agg na
    WHERE sni.niche = na.niche
  `.catch(() => null)
  return { ok: !!result, totalActive }
}

// ────────────────────────────── Orchestrator ──────────────────────────────

export async function refreshMarketSaturation() {
  const startedAt = Date.now()
  await ensureMarketSaturationColumns()

  const saturation = await computeSaturationScores().catch((e) => ({ ok: false, error: String(e) }))
  const pressure = await computePricingPressure().catch((e) => ({ ok: false, error: String(e) }))
  const clusters = await buildDuplicateClusters().catch((e) => ({ duplicateGroups: 0, clusteredProducts: 0, totalProducts: 0, error: String(e) }))
  const quality = await computeInventoryQuality().catch((e) => ({ ok: false, error: String(e) }))
  const nicheAnalytics = await computeNicheSaturationAnalytics().catch((e) => ({ ok: false, error: String(e) }))

  return {
    durationMs: Date.now() - startedAt,
    saturation,
    pressure,
    clusters,
    quality,
    nicheAnalytics,
  }
}

// ────────────────────────────── Analytics read (UI) ──────────────────────────────

export async function getMarketSaturationAnalytics() {
  await ensureMarketSaturationColumns()

  const [topSaturated, healthiestLowComp, marginStability, repricingPressure, supplyDemand, biggestDupClusters, concentration, raceToBottom] = await Promise.all([
    // Top saturated niches
    queryRows`
      SELECT niche, avg_saturation, avg_inventory_quality, active_products, sold_30d
      FROM source_niche_intelligence
      WHERE avg_saturation IS NOT NULL AND active_products >= 5
      ORDER BY avg_saturation DESC
      LIMIT 10
    `.catch(() => []),
    // Healthiest low-competition niches
    queryRows`
      SELECT niche, avg_saturation, avg_inventory_quality, sell_through_rate, active_products
      FROM source_niche_intelligence
      WHERE avg_inventory_quality IS NOT NULL AND active_products >= 5
      ORDER BY avg_inventory_quality DESC, avg_saturation ASC
      LIMIT 10
    `.catch(() => []),
    // Margin stability by category (low pricing pressure = stable)
    queryRows`
      SELECT niche, avg_pricing_pressure, avg_roi, avg_profit, active_products
      FROM source_niche_intelligence
      WHERE avg_pricing_pressure IS NOT NULL AND active_products >= 5
      ORDER BY avg_pricing_pressure ASC
      LIMIT 10
    `.catch(() => []),
    // Average repricing pressure (worst)
    queryRows`
      SELECT niche, avg_pricing_pressure, avg_roi, active_products
      FROM source_niche_intelligence
      WHERE avg_pricing_pressure IS NOT NULL AND active_products >= 5
      ORDER BY avg_pricing_pressure DESC
      LIMIT 10
    `.catch(() => []),
    // Oversupplied vs undersupplied (supply_demand_ratio = active / sold_30d)
    queryRows`
      SELECT niche, supply_demand_ratio, active_products, sold_30d, sell_through_rate
      FROM source_niche_intelligence
      WHERE supply_demand_ratio IS NOT NULL AND active_products >= 5
      ORDER BY supply_demand_ratio DESC
      LIMIT 12
    `.catch(() => []),
    // Biggest duplicate clusters
    queryRows`
      SELECT dup_cluster_id,
             MAX(title) AS sample_title,
             MAX(source_niche) AS niche,
             COUNT(*)::int AS cluster_size,
             ROUND(AVG(inventory_quality_score), 1) AS avg_quality
      FROM product_source_items
      WHERE active = TRUE AND dup_cluster_id IS NOT NULL AND dup_cluster_size > 1
      GROUP BY dup_cluster_id
      ORDER BY cluster_size DESC
      LIMIT 15
    `.catch(() => []),
    // Sourcing concentration
    queryRows`
      SELECT niche, concentration_pct, active_products, avg_inventory_quality
      FROM source_niche_intelligence
      WHERE concentration_pct IS NOT NULL
      ORDER BY concentration_pct DESC
      LIMIT 12
    `.catch(() => []),
    // Race-to-bottom products (high pressure + collapsing ROI)
    queryRows`
      SELECT asin, title, source_niche AS niche, roi, roi_trend, pricing_pressure_score, ebay_competitor_count
      FROM product_source_items
      WHERE active = TRUE AND pricing_pressure_score IS NOT NULL
        AND pricing_pressure_score > 40
      ORDER BY pricing_pressure_score DESC, roi_trend ASC
      LIMIT 15
    `.catch(() => []),
  ])

  return { topSaturated, healthiestLowComp, marginStability, repricingPressure, supplyDemand, biggestDupClusters, concentration, raceToBottom }
}
