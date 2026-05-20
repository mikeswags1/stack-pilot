import type { AutoListingSettings, ScoredCandidate } from '@/lib/auto-listing/types'
import { queryRows } from '@/lib/db'
import { ensureProductSourceTables } from '@/lib/product-source-engine'

function parseNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const n = Number.parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function modeRiskMultiplier(mode: AutoListingSettings['mode']) {
  if (mode === 'safe') return 0.88
  if (mode === 'aggressive') return 1.08
  return 1.0
}

export async function getTopAutoListingCandidates(userId: string | number, settings: AutoListingSettings, limit = 120) {
  await ensureProductSourceTables()
  const allowedNiches = settings.allowed_niches || []
  const nicheFilter = allowedNiches.length > 0

  // Cap per-niche to ensure diversity: never let one niche monopolize the queue.
  // We fetch more rows than needed, then cap per niche in JS before scoring.
  const fetchLimit = Math.max(limit * 3, 300)
  const MAX_PER_NICHE = Math.max(6, Math.ceil(limit / Math.max(1, allowedNiches.length || 18)))

  const rows = await queryRows<{
    asin: string
    title: string
    source_niche: string | null
    amazon_price: string | number
    ebay_price: string | number
    profit: string | number
    roi: string | number
    image_url: string | null
    risk: string | null
    sales_volume: string | null
    rating: string | number | null
    review_count: number | null
    total_score: string | number | null
    intelligence_score: string | number | null
    source_quality: string | null
    raw: Record<string, unknown> | null
    last_seen_at: string
    ebay_competitor_count: number | null
    listing_outcome_score: string | number | null
    cached_bsr: number | null
  }>`
    SELECT
      psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price, psi.profit, psi.roi,
      psi.image_url, psi.risk, psi.sales_volume, psi.rating, psi.review_count, psi.total_score,
      psi.intelligence_score, psi.source_quality, psi.raw, psi.last_seen_at,
      psi.ebay_competitor_count, psi.listing_outcome_score,
      apc.best_seller_rank AS cached_bsr
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE
      AND psi.roi >= ${settings.min_roi}
      AND psi.profit >= 3
      AND psi.risk <> 'HIGH'
      AND psi.image_url IS NOT NULL
      AND psi.image_url <> ''
      AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
      AND COALESCE(apc.available, TRUE) <> FALSE
      AND (${nicheFilter} = FALSE OR psi.source_niche = ANY(${allowedNiches}::text[]))
      AND NOT EXISTS (
        SELECT 1 FROM listed_asins la
        WHERE la.user_id = ${userId} AND la.asin = psi.asin AND la.ended_at IS NULL
      )
    ORDER BY psi.intelligence_score DESC NULLS LAST, psi.total_score DESC NULLS LAST
    LIMIT ${Math.max(10, Math.min(1200, fetchLimit))}
  `.catch(() => [])

  // Apply per-niche cap to guarantee diversity across niches
  const nicheCounts = new Map<string, number>()
  const diverseRows = rows.filter((r) => {
    const niche = r.source_niche || 'Unassigned'
    const count = nicheCounts.get(niche) || 0
    if (count >= MAX_PER_NICHE) return false
    nicheCounts.set(niche, count + 1)
    return true
  })

  const now = Date.now()
  const riskMult = modeRiskMultiplier(settings.mode)

  const scored: ScoredCandidate[] = diverseRows
    .map((r) => {
      const baseScore = parseNumber(r.intelligence_score) || parseNumber(r.total_score)
      const roi = parseNumber(r.roi)
      const profit = parseNumber(r.profit)
      const amazonPrice = parseNumber(r.amazon_price)
      const ebayPrice = parseNumber(r.ebay_price)
      const rating = parseNumber(r.rating || 0)
      const reviews = parseNumber(r.review_count || 0)
      const ageHours = clamp((now - new Date(r.last_seen_at).getTime()) / 36e5, 0, 720)
      const qualityMultiplier = r.source_quality === 'ready' ? 1.08 : r.source_quality === 'stale' ? 0.82 : r.source_quality === 'needs_images' ? 0.72 : 1

      // These are *approximations* with current data we have. As we accumulate logs,
      // we can replace placeholders with true historical conversion, validation history, etc.
      const sellThroughEstimate = clamp(Math.log10(Number(String(r.sales_volume || '').replace(/[^0-9]/g, '') || 1) + 1) / 2, 0, 1)
      const supplierReliability = clamp(r.image_url ? 1 : 0.6, 0, 1)
      const stalenessPenalty = clamp(1 - ageHours / 240, 0.5, 1)
      const ratingBoost = clamp((rating - 3.6) / 1.4, 0, 1) * 10
      const reviewBoost = clamp(Math.log10(reviews + 1) / 3, 0, 1) * 8
      const profitBoost = clamp(profit / 25, 0, 1) * 18
      const roiBoost = clamp((roi - settings.min_roi) / 80, 0, 1) * 20
      const quality = clamp((baseScore / 120) * 25, 0, 25)

      // BSR boost: lower rank = proven high demand
      const bsr = r.cached_bsr
      const bsrBoost = bsr
        ? bsr <= 500 ? 18 : bsr <= 2000 ? 12 : bsr <= 10000 ? 6 : bsr <= 50000 ? 0 : -6
        : 0

      // Competition penalty: more eBay sellers = harder to sell
      const competitors = r.ebay_competitor_count
      const competitionPenalty = competitors !== null && competitors !== undefined
        ? competitors <= 10 ? 4 : competitors <= 30 ? 0 : competitors <= 75 ? -8 : competitors <= 150 ? -16 : -25
        : 0

      // Outcome multiplier: products that historically list and stay active score higher
      const outcomeMult = r.listing_outcome_score !== null && r.listing_outcome_score !== undefined
        ? clamp(Number(r.listing_outcome_score), 0.60, 1.25)
        : 1.0

      const scoreBreakdown = {
        base: baseScore,
        roi: roiBoost,
        profit: profitBoost,
        demand: sellThroughEstimate * 18,
        rating: ratingBoost,
        reviews: reviewBoost,
        supplier: supplierReliability * 6,
        quality,
        staleness: (stalenessPenalty - 1) * 30,
        bsr: bsrBoost,
        competition: competitionPenalty,
      }

      const scoreRaw = Object.values(scoreBreakdown).reduce((a, b) => a + b, 0) * riskMult * qualityMultiplier * outcomeMult

      const selectedReason =
        roi >= settings.min_roi + 25
          ? `High ROI (${Math.round(roi)}%) and strong pool score.`
          : profit >= 15
            ? `High profit ($${profit.toFixed(0)}) with acceptable ROI.`
            : `Strong overall score with stable margins.`

      return {
        asin: r.asin,
        title: r.title,
        sourceNiche: r.source_niche,
        amazonPrice,
        ebayPrice,
        profit,
        roi,
        imageUrl: r.image_url,
        baseScore,
        score: Number.isFinite(scoreRaw) ? Number(scoreRaw.toFixed(2)) : 0,
        scoreBreakdown,
        selectedReason,
        raw: r.raw || undefined,
      }
    })
    .sort((a, b) => b.score - a.score)

  return scored
}

