// Phase 4 — Staged enrichment (the selective, quota-gated half of the funnel).
//
//   mass discovery (free)  →  lightweight filter  →  dedupe  →  priority score
//        →  [THIS MODULE: quota-gated enrichment]  →  validation/preflight  →  list-ready
//
// Discovery floods the universe with cheap raw candidates. We do NOT enrich them all — that
// would burn the 10K/mo RapidAPI budget instantly. Instead we pick only the strongest raw
// candidates (high priority score + confidence, evergreen / historically-successful niches)
// and pull full product detail for them, promoting enrichment_status raw → enriched.
//
// Enrichment is hard-gated on the RapidAPI quota (Phase 0) and capped by an admin budget.

import { queryRows, sql } from '@/lib/db'
import { fetchProductDetailsFromApi, saveCachedAmazonProduct } from '@/lib/amazon-product'
import { getThrottleState } from '@/lib/quota-tracker'
import { ensureDiscoveryColumns } from '@/lib/source-graph'

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v || 0)
  return Number.isFinite(n) ? n : 0
}

export type EnrichmentRunResult = {
  considered: number
  enriched: number
  failed: number
  promoted: number
  skipped?: string
  durationMs: number
}

/**
 * Promote the strongest raw candidates to full enrichment.
 *
 * Selection priority (the "reserve enrichment for high-confidence candidates" rule):
 *   - enrichment_status = 'raw' (not yet enriched)
 *   - rank by: discovery_confidence × niche health × intelligence/quality score
 *   - prefer evergreen + niches with proven sell-through (outcome_multiplier)
 *
 * Each enrichment = 1 RapidAPI product-details call. Hard-gated on the rapidapi quota state
 * and capped at `budget`.
 */
export async function enrichTopCandidates(opts: { budget: number; maxRuntimeMs?: number } = { budget: 20 }): Promise<EnrichmentRunResult> {
  await ensureDiscoveryColumns()
  const startedAt = Date.now()
  const budget = Math.max(0, Math.min(100, opts.budget))
  const maxRuntime = opts.maxRuntimeMs ?? 120_000

  const result: EnrichmentRunResult = { considered: 0, enriched: 0, failed: 0, promoted: 0, durationMs: 0 }
  if (budget === 0) { result.skipped = 'budget_zero'; result.durationMs = Date.now() - startedAt; return result }

  // Quota gate — enrichment is the expensive step. Stand down when RapidAPI is in warn/block.
  const quotaState = await getThrottleState('rapidapi').catch(() => 'ok' as const)
  if (quotaState !== 'ok') { result.skipped = `rapidapi_${quotaState}`; result.durationMs = Date.now() - startedAt; return result }

  // Select strongest raw candidates. Join niche intelligence so we favor niches that actually
  // sell (outcome_multiplier) and high inventory quality. Confidence breaks ties.
  // Skip candidates that already failed enrichment 2+ times (they become 'enrich_failed').
  const rows = await queryRows<{ asin: string; image_url: string | null }>`
    SELECT psi.asin, psi.image_url
    FROM product_source_items psi
    LEFT JOIN source_niche_intelligence sni
      ON sni.niche = COALESCE(NULLIF(psi.source_niche, ''), 'Unassigned')
    WHERE psi.active = TRUE
      AND psi.enrichment_status = 'raw'
      AND psi.source_quality <> 'reject'
      AND COALESCE(psi.enrichment_attempts, 0) < 2
    ORDER BY
      (
        COALESCE(psi.discovery_confidence, 0.5)
        * COALESCE(sni.outcome_multiplier, 1)
        * COALESCE(sni.learning_multiplier, 1)
        * (1 + COALESCE(psi.inventory_quality_score, 50) / 100.0)
        * (1 + COALESCE(psi.intelligence_score, psi.total_score) / 500.0)
      ) DESC,
      psi.discovery_confidence DESC NULLS LAST
    LIMIT ${budget}
  `.catch(() => [])

  for (const row of rows) {
    if (Date.now() - startedAt > maxRuntime) break
    result.considered++
    const detail = await fetchProductDetailsFromApi(row.asin, row.image_url || undefined).catch(() => null)
    if (!detail) {
      result.failed++
      // Increment attempt; after 2 failures mark 'enrich_failed' so we stop re-picking it
      // (avoids wasting RapidAPI quota on a chronically-failing ASIN) and it shows in metrics.
      await sql`
        UPDATE product_source_items
        SET last_validated_at = NOW(),
            enrichment_attempts = COALESCE(enrichment_attempts, 0) + 1,
            enrichment_status = CASE WHEN COALESCE(enrichment_attempts, 0) + 1 >= 2 THEN 'enrich_failed' ELSE enrichment_status END
        WHERE asin = ${row.asin}
      `.catch(() => {})
      continue
    }

    result.enriched++

    // Persist the enriched detail into the Amazon cache so list-product reuses it (avoids a
    // repeat page load at list time — aggressive caching).
    await saveCachedAmazonProduct(detail).catch(() => {})

    const images = Array.isArray(detail.images) ? detail.images : []
    const hasRichImages = images.length >= 2
    const available = detail.available && detail.amazonPrice > 0

    await sql`
      UPDATE product_source_items
      SET enrichment_status = 'enriched',
          image_url = COALESCE(${images[0] || detail.imageUrl || null}, image_url),
          amazon_price = ${available ? detail.amazonPrice.toFixed(2) : null},
          last_validated_at = NOW(),
          raw = raw || ${JSON.stringify({ images, features: detail.features || [], description: detail.description || '', enrichedAt: new Date().toISOString() })}::jsonb,
          source_quality = CASE
            WHEN ${!available} THEN 'reject'
            WHEN ${hasRichImages} THEN 'candidate'
            ELSE source_quality
          END,
          active = CASE WHEN ${!available} THEN FALSE ELSE active END
      WHERE asin = ${row.asin}
    `.catch(() => {})
    if (available) result.promoted++
  }

  result.durationMs = Date.now() - startedAt
  return result
}
