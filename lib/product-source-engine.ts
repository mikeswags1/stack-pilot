import { queryRows, sql } from '@/lib/db'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getNetProfit, getRecommendedEbayPrice, getTargetRoi, MIN_NET_PROFIT } from '@/lib/listing-pricing'
import { getListingPolicyFlags, hasBlockedListingPolicyFlag } from '@/lib/listing-policy'
import { scrapeAmazonProduct } from '@/lib/amazon-scrape'
import { getRapidApiKey } from '@/lib/rapidapi'
import { getListingTitleQuality, isWeakListingTitle } from '@/lib/listing-quality'
import { getSourcingTrendMultiplier, getSourcingTrendSignals } from '@/lib/source-niches'
import { decodeHtmlEntitiesDeep } from '@/lib/html-entities'

/** Minimum master score for a product to enter the active pool. Below this = auto-reject. */
const MIN_MASTER_SCORE = 38

/**
 * Source-time rule gates derived from the 2026-05-31 audit (docs/postmortem-bulk-end-bug.md
 * and the dynamic-pricing simulation). These are HARD filters applied in the list-ready
 * SQL query so junk products never reach the dashboard or auto-listing queue.
 *
 * Rule C: cost-to-market ratio. Across 852 ENDed listings, average Amazon cost was 1.65×
 * the cheapest eBay competitor — meaning we paid retail for products eBay sellers liquidate.
 * Anything at or above this ratio cannot return $4+ net profit at a competitive price.
 */
/**
 * RULE E — Title-pattern blocklist (added 2026-06-02 after 30/30 fail-rate event).
 *
 * Empirically, these patterns produce hard eBay-side rejections in list-product/route.ts:
 *   - Oversized/fragile/high-return (couch, sofa, TV, etc.) → rejected by drop-shipping guardrails
 *   - Amazon-owned brands (kindle, echo, fire tv) → rejected by cross-listing guardrails
 *   - Apparel → fails on missing "Department" specific (auto-fill gap; #28 fix planned)
 *
 * These products survived the niche-blacklist (Rule A) because their source_niche was
 * something generic like "Television" or "Furniture". Title-pattern matching catches them
 * directly. Each pattern is a Postgres ILIKE pattern (case-insensitive).
 *
 * When #28 (Department auto-fill) ships, we'll remove the apparel patterns from this list.
 */
const LISTING_TITLE_BLOCKLIST = [
  // Oversized / fragile / high-return — drop-shipping guardrail rejects
  '%television%', '% tv %', '%couch%', '%sofa%', '%mattress%', '%recliner%',
  '%refrigerator%', '%washing machine%', '%dishwasher%', '%dryer%', '%treadmill%',
  '%piano%', '%aquarium%', '%fish tank%', '%lawn mower%',
  // Amazon-owned brands — cross-listing guardrail rejects
  '%kindle%', '%echo dot%', '%echo show%', '%fire tv%', '%fire tablet%',
  '%ring doorbell%', '%ring camera%', '%blink camera%', '%amazon basics%',
  // Apparel — fails on missing Department specific (until #28 ships)
  '%t-shirt%', '%t shirt%', '%tshirt%', '%hoodie%', '%sweatshirt%',
  '%pants%', '%jeans%', '%dress%', '%blouse%', '%halter%', '%tank top%',
  '%jacket%', '%coat%', '%sweater%', '%cardigan%', '%leggings%',
  '%skirt%', '%shorts%', '%bikini%', '%swimsuit%',
] as const

export type ProductScores = {
  profitScore: number       // 0–100  (20% weight)
  roiScore: number          // 0–100  (15% weight)
  demandScore: number       // 0–100  (18% weight)
  reviewScore: number       // 0–100  (8%  weight)
  competitionScore: number  // 0–100  (12% weight) — higher = less competition = better
  imageScore: number        // 0–100  (7%  weight)
  titleScore: number        // 0–100  (5%  weight)
  riskScore: number         // 0–100  (8%  weight) — inverted: higher = safer
  reliabilityScore: number  // 0–100  (4%  weight)
  opportunityScore: number  // 0–100  (3%  weight) — demand gap index
  masterScore: number       // 0–100  weighted composite — primary pool ranking signal
  legacyScore: number       // backward-compat: existing unbounded total_score
}

export type SourceEngineProduct = {
  asin: string
  title: string
  amazonPrice: number
  ebayPrice: number
  profit: number
  roi: number
  imageUrl?: string
  risk: string
  salesVolume?: string
  images?: string[]
  features?: string[]
  description?: string
  specs?: Array<[string, string]>
  sourceNiche?: string
  sourceQuality?: string
  qualityScore?: number
  masterScore?: number
  available?: boolean
  primeEligible?: boolean | null
  deliveryDaysMax?: number | null
  fastFulfillment?: boolean | null
  fulfillmentSummary?: string | null
  _rating?: number
  _numRatings?: number
  bestSellerRank?: number
  ebayCompetitorCount?: number
  listingOutcomeScore?: number
  /** Sum of "X sold" across top eBay competitor listings — comparative sell-through. */
  ebaySoldVelocity?: number
  /** Freshly-scraped Amazon title from amazon_product_cache. Used alongside title for
   *  policy checks since psi.title can be stale and Amazon may have updated the listing. */
  cachedTitle?: string
}

type SourceProductInput = Partial<SourceEngineProduct> & {
  asin: string
  title: string
  sourceProvider?: string
  sourceQuery?: string
  raw?: unknown
}

type ProductSourceRow = {
  asin: string
  title: string
  source_niche: string | null
  amazon_price: string | number | null
  ebay_price: string | number | null
  profit: string | number | null
  roi: string | number | null
  image_url: string | null
  risk: string | null
  sales_volume: string | null
  rating: string | number | null
  review_count: string | number | null
  total_score: string | number | null
  intelligence_score: string | number | null
  source_quality: string | null
  raw: Record<string, unknown> | null
  cached_title?: string | null
  cached_amazon_price?: string | number | null
  cached_primary_image?: string | null
  cached_images?: string[] | null
  cached_features?: string[] | null
  cached_description?: string | null
  cached_specs?: Array<[string, string]> | null
  cached_available?: boolean | null
  cached_prime_eligible?: boolean | null
  cached_delivery_days_max?: number | null
  cached_fast_fulfillment?: boolean | null
  cached_fulfillment_summary?: string | null
  cached_bsr?: number | null
  ebay_competitor_count?: number | null
  ebay_sold_velocity?: number | null
  listing_outcome_score?: string | number | null
}

type ProductCacheRow = {
  niche: string
  results: SourceEngineProduct[]
}

function parseNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (!value) return 0
  const parsed = Number.parseFloat(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeComparableTitle(value: string) {
  return decodeHtmlEntitiesDeep(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(pack|set|piece|pcs|count|for|with|and|the|a|an|of|to|in)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getTitleMatchScore(sourceTitle: string, cachedTitle?: string) {
  if (!cachedTitle) return 1
  const sourceWords = new Set(normalizeComparableTitle(sourceTitle).split(' ').filter(Boolean))
  const cachedWords = new Set(normalizeComparableTitle(cachedTitle).split(' ').filter(Boolean))
  if (sourceWords.size === 0 || cachedWords.size === 0) return 0
  let overlap = 0
  for (const word of sourceWords) {
    if (cachedWords.has(word)) overlap += 1
  }
  return overlap / Math.max(sourceWords.size, cachedWords.size)
}

function canonicalImageKey(value: string) {
  return String(value || '')
    .replace(/\?.*$/, '')
    .replace(/\._[^./]+(?=\.[a-z0-9]+$)/i, '')
    .toLowerCase()
}

function hasAtLeastDistinctImages(product: SourceEngineProduct, minimum = 2) {
  const images = Array.isArray(product.images) ? product.images : []
  const keys = new Set(
    images
      .filter((url) => typeof url === 'string' && url.startsWith('http'))
      .map(canonicalImageKey)
      .filter(Boolean)
  )
  return keys.size >= minimum
}

/** Cap parsed “sold” counts so bogus listing text cannot dominate log-scored demand. */
function parseSales(value?: string) {
  if (!value) return 1
  const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(1, Math.min(80_000, parsed))
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function compactJson(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, unknown>
}

function getRisk(price: number, roi: number) {
  if (price > 150) return 'HIGH'
  if (price > 60 || roi < 45) return 'MEDIUM'
  return 'LOW'
}

/** Compute all 10 sub-scores plus the master score (0–100) and legacy total_score. */
export function computeProductScores(product: SourceEngineProduct): ProductScores {
  const rating = product._rating && product._rating > 0 ? product._rating : 3.8
  const reviews = product._numRatings || 0
  const sales = parseSales(product.salesVolume)
  const margin = product.ebayPrice > 0 ? (product.profit / product.ebayPrice) * 100 : 0
  const imageCount = Math.max(product.images?.length || 0, product.imageUrl ? 1 : 0)
  const bsr = product.bestSellerRank
  const competitors = product.ebayCompetitorCount
  const trendSignals = getSourcingTrendSignals({
    title: product.title,
    sourceNiche: product.sourceNiche,
    price: product.amazonPrice,
    imageCount,
  })

  // 1. Profit Score (0–100) — price-tier adjusted
  const targetProfit = Math.max(8, product.amazonPrice * 0.22)
  const profitRaw = clamp((product.profit - 3) / Math.max(targetProfit - 3, 5), 0, 1.5) * 65
  const profitBonus = product.profit >= 20 ? 20 : product.profit >= 14 ? 12 : product.profit >= 9 ? 5 : 0
  const profitScore = clamp(profitRaw + profitBonus, 0, 100)

  // 2. ROI Score (0–100) — target ROI is price-tier adjusted
  const targetRoi = getTargetRoi(product.amazonPrice, { risk: product.risk })
  const roiScore = clamp(product.roi / Math.max(targetRoi, 20), 0, 2.2) * 45

  // 3. Demand Score (0–100) — BSR + reviews + rating + sales velocity
  const bsrSignal = !bsr ? 15 : bsr <= 500 ? 35 : bsr <= 2000 ? 28 : bsr <= 10000 ? 20 : bsr <= 50000 ? 12 : 5
  const reviewSignal = Math.log10(reviews + 10) * 22
  const ratingSignal = clamp((rating - 3.0) / 2.0, 0, 1) * 18
  const salesSignal = Math.log10(sales + 10) * 15
  const demandScore = clamp(bsrSignal + reviewSignal + ratingSignal + salesSignal, 0, 100)

  // 4. Review Score (0–100) — count + rating
  const reviewCountScore = clamp(reviews / 500, 0, 1) * 50
  const reviewRatingScore = clamp((rating - 3.0) / 2.0, 0, 1) * 50
  const reviewScore = clamp(reviewCountScore + reviewRatingScore, 0, 100)

  // 5. Competition Score (0–100) — higher = less eBay competition = better
  const competitionScore = competitors === undefined || competitors < 0 ? 50
    : competitors <= 5 ? 95
    : competitors <= 15 ? 80
    : competitors <= 40 ? 60
    : competitors <= 100 ? 35
    : 15

  // 6. Image Quality Score (0–100)
  const imageScore = imageCount >= 6 ? 100 : imageCount >= 4 ? 85 : imageCount >= 3 ? 70
    : imageCount >= 2 ? 50 : imageCount >= 1 ? 20 : 0

  // 7. Title Quality Score (0–100)
  const tq = getListingTitleQuality(product.title)
  const titleScore = tq.weak ? 0 : clamp(tq.score / 2, 0, 100)

  // 8. Risk Score (0–100, inverted — higher = safer)
  const baseRisk = product.risk === 'LOW' ? 80 : product.risk === 'MEDIUM' ? 50 : 15
  const logisticsPenalty = trendSignals.highReturnRisk ? -20 : 0
  const pricePenalty = product.amazonPrice > 100 ? -10 : 0
  const riskScore = clamp(baseRisk + logisticsPenalty + pricePenalty, 0, 100)

  // 9. Source Reliability Score (0–100) — data freshness + completeness
  const features = product.features || []
  const specs = product.specs || []
  const description = product.description || ''
  const reliabilityScore = clamp(
    30 +
    (imageCount >= 2 ? 20 : product.imageUrl ? 10 : 0) +
    (features.length >= 3 ? 12 : 0) +
    (specs.length >= 2 ? 8 : 0) +
    (description.length >= 100 ? 8 : 0) +
    (reviews >= 25 ? 12 : reviews >= 10 ? 6 : 0) +
    (rating >= 4.0 ? 10 : 0),
    0, 100,
  )

  // 10. Opportunity Score (0–100) — demand gap: strong Amazon demand + low eBay supply
  const demandSignal = !bsr ? 0.3 : bsr <= 10000 ? 1.0 : bsr <= 50000 ? 0.6 : 0.25
  const supplySignal = competitors === undefined || competitors < 0 ? 0.5
    : competitors <= 10 ? 1.0 : competitors <= 30 ? 0.7 : competitors <= 75 ? 0.4 : 0.15
  const opportunityScore = clamp(demandSignal * supplySignal * 100, 0, 100)

  // Master Score — weighted composite (0–100)
  const masterScore = clamp(
    profitScore * 0.20 +
    roiScore * 0.15 +
    demandScore * 0.18 +
    reviewScore * 0.08 +
    competitionScore * 0.12 +
    imageScore * 0.07 +
    titleScore * 0.05 +
    riskScore * 0.08 +
    reliabilityScore * 0.04 +
    opportunityScore * 0.03,
    0, 100,
  )

  // Legacy total_score — backward-compat unbounded formula (kept for existing ORDER BY sorts)
  const trendMultiplier = getSourcingTrendMultiplier({
    title: product.title,
    sourceNiche: product.sourceNiche,
    price: product.amazonPrice,
    imageCount,
  })
  const reviewTrust = reviews >= 80 ? 1.08 : reviews >= 35 ? 1.04 : reviews < 8 ? 0.92 : 1
  const priceSweetSpot = product.amazonPrice >= 12 && product.amazonPrice <= 120 ? 18 : product.amazonPrice > 180 ? 7 : 12
  const riskPenalty = product.risk === 'HIGH' ? 0.72 : product.risk === 'MEDIUM' ? 0.9 : 1
  const imageBoost = imageCount >= 4 ? 12 : imageCount >= 2 ? 8 : product.imageUrl ? 3 : -10
  const logisticsBoost = trendSignals.lightweight ? 8 : trendSignals.highReturnRisk ? -18 : 0
  const bsrMultiplier = bsr ? bsr <= 500 ? 1.25 : bsr <= 2000 ? 1.15 : bsr <= 10000 ? 1.07 : bsr <= 50000 ? 1.0 : 0.91 : 1.0
  const competitionMultiplier = competitors === undefined || competitors < 0 ? 1.0
    : competitors <= 10 ? 1.05 : competitors <= 30 ? 0.97 : competitors <= 75 ? 0.88
    : competitors <= 150 ? 0.76 : 0.60
  const outcomeMult = Number.isFinite(product.listingOutcomeScore) && (product.listingOutcomeScore ?? 0) > 0
    ? clamp(product.listingOutcomeScore!, 0.60, 1.25)
    : 1.0
  const demandLegacy = Math.log10(sales + 10) * 16 + Math.log10(reviews + 25) * 15 + clamp(rating / 5, 0.65, 1.05) * 19
  const profitLegacy = clamp(product.profit, 0, 120) * 1.02
  const roiLegacy = clamp(product.roi / 65, 0.38, 1.85) * 26
  const marginLegacy = clamp(margin / 30, 0.38, 1.55) * 19
  const legacyTotal =
    (profitLegacy + roiLegacy + marginLegacy + demandLegacy + priceSweetSpot + imageBoost + logisticsBoost) *
    riskPenalty * reviewTrust * trendMultiplier * bsrMultiplier * competitionMultiplier * outcomeMult
  const legacyScore = Number.isFinite(legacyTotal) ? Number(legacyTotal.toFixed(2)) : 0

  return {
    profitScore: Math.round(profitScore),
    roiScore: Math.round(clamp(roiScore, 0, 100)),
    demandScore: Math.round(demandScore),
    reviewScore: Math.round(reviewScore),
    competitionScore: Math.round(competitionScore),
    imageScore: Math.round(imageScore),
    titleScore: Math.round(clamp(titleScore, 0, 100)),
    riskScore: Math.round(riskScore),
    reliabilityScore: Math.round(reliabilityScore),
    opportunityScore: Math.round(opportunityScore),
    masterScore: Math.round(masterScore * 10) / 10,
    legacyScore,
  }
}

/** Backward-compat wrapper — returns legacy total_score used in existing ORDER BY clauses. */
function scoreProduct(product: SourceEngineProduct): number {
  return computeProductScores(product).legacyScore
}

function normalizeProduct(input: SourceProductInput): (SourceEngineProduct & { sourceProvider: string; sourceQuery?: string; raw: Record<string, unknown> }) | null {
  const asin = String(input.asin || '').trim().toUpperCase()
  const title = String(input.title || '').trim()
  const amazonPrice = parseNumber(input.amazonPrice)
  if (!asin || !title || amazonPrice <= 0) return null
  if (isWeakListingTitle(title)) return null

  const ebayPrice = getRecommendedEbayPrice(amazonPrice, EBAY_DEFAULT_FEE_RATE)
  const metrics = getListingMetrics(amazonPrice, ebayPrice, EBAY_DEFAULT_FEE_RATE)
  const profit = metrics.profit
  const roi = metrics.roi
  const risk = input.risk || getRisk(amazonPrice, roi)
  const product: SourceEngineProduct & { sourceProvider: string; sourceQuery?: string; raw: Record<string, unknown> } = {
    asin,
    title,
    amazonPrice,
    ebayPrice,
    profit,
    roi,
    imageUrl: input.imageUrl,
    risk,
    salesVolume: input.salesVolume,
    images: input.images,
    features: input.features,
    description: input.description,
    specs: input.specs,
    sourceNiche: input.sourceNiche,
    _rating: input._rating,
    _numRatings: input._numRatings,
    sourceProvider: input.sourceProvider || 'cache',
    sourceQuery: input.sourceQuery,
    raw: compactJson(input.raw),
  }
  const policyFlags = getListingPolicyFlags({
    title: product.title,
    description: product.description,
    niche: product.sourceNiche,
  })
  if (hasBlockedListingPolicyFlag(policyFlags)) return null

  const scores = computeProductScores(product)
  product.qualityScore = scores.legacyScore
  product.masterScore = scores.masterScore

  // Apply quality gate: products below the master score floor are auto-rejected.
  // They still enter the DB (as 'reject') so we can track why the pool is thin.
  if (scores.masterScore < MIN_MASTER_SCORE) {
    product.sourceQuality = 'reject'
  }

  return product
}

function rowToProduct(row: ProductSourceRow): SourceEngineProduct {
  const raw = row.raw || {}
  // Prefer the verified Amazon cache over the original search-result row. Search rows can
  // go stale or carry a mismatched title for the ASIN; the cache is fetched by ASIN and is
  // what list-product validates again immediately before publishing.
  const canonicalTitle = String(row.cached_title || row.title || '').trim()
  const cachedAmazonPrice = parseNumber(row.cached_amazon_price)
  const amazonPrice = cachedAmazonPrice > 0 ? cachedAmazonPrice : parseNumber(row.amazon_price)
  const ebayPrice = getRecommendedEbayPrice(amazonPrice, EBAY_DEFAULT_FEE_RATE)
  const metrics = getListingMetrics(amazonPrice, ebayPrice, EBAY_DEFAULT_FEE_RATE)
  const rawImages = Array.isArray(raw.images) ? raw.images as string[] : []
  const cachedImages = Array.isArray(row.cached_images) ? row.cached_images : []
  const images = Array.from(new Set([
    row.cached_primary_image,
    ...cachedImages,
    ...rawImages,
    row.image_url,
  ].filter((url): url is string => typeof url === 'string' && url.startsWith('http'))))
  const rawFeatures = Array.isArray(raw.features) ? raw.features as string[] : undefined
  const rawSpecs = Array.isArray(raw.specs) ? raw.specs as Array<[string, string]> : undefined
  const product: SourceEngineProduct = {
    asin: row.asin,
    title: canonicalTitle,
    amazonPrice,
    ebayPrice,
    profit: metrics.profit,
    roi: metrics.roi,
    imageUrl: images[0] || row.image_url || undefined,
    risk: getRisk(amazonPrice, metrics.roi),
    salesVolume: row.sales_volume || undefined,
    images: images.length > 0 ? images : undefined,
    features: (row.cached_features?.length || 0) > 0 ? row.cached_features || undefined : rawFeatures,
    description: row.cached_description || (typeof raw.description === 'string' ? raw.description : undefined),
    specs: (row.cached_specs?.length || 0) > 0 ? row.cached_specs || undefined : rawSpecs,
    sourceNiche: row.source_niche || undefined,
    sourceQuality: row.cached_available === true && row.cached_fast_fulfillment !== false && images.length >= 2 && row.source_quality !== 'reject' ? 'ready' : row.source_quality || undefined,
    // If no amazon_product_cache row exists (LEFT JOIN → null), assume available.
    // Only explicitly mark unavailable when the cache confirms available = FALSE.
    // Using undefined previously caused isPublishReadyProduct (available === true check)
    // to reject every pool product lacking a cache entry, shrinking publishReadyCount to 0.
    available: row.cached_available ?? true,
    primeEligible: row.cached_prime_eligible ?? null,
    deliveryDaysMax: row.cached_delivery_days_max ?? null,
    fastFulfillment: row.cached_fast_fulfillment ?? null,
    fulfillmentSummary: row.cached_fulfillment_summary ?? null,
    _rating: parseNumber(row.rating),
    _numRatings: Math.round(parseNumber(row.review_count)),
    bestSellerRank: row.cached_bsr ?? undefined,
    ebayCompetitorCount: row.ebay_competitor_count !== null && row.ebay_competitor_count !== undefined ? Number(row.ebay_competitor_count) : undefined,
    ebaySoldVelocity: row.ebay_sold_velocity !== null && row.ebay_sold_velocity !== undefined ? Number(row.ebay_sold_velocity) : undefined,
    listingOutcomeScore: row.listing_outcome_score !== null && row.listing_outcome_score !== undefined ? parseNumber(row.listing_outcome_score) : undefined,
    cachedTitle: row.cached_title || undefined,
  }
  product.qualityScore = parseNumber(row.intelligence_score) || scoreProduct(product)
  return product
}

export async function ensureProductSourceTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS amazon_product_cache (
      asin TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      amazon_price NUMERIC(10,2) NOT NULL,
      primary_image TEXT,
      images JSONB NOT NULL DEFAULT '[]'::jsonb,
      features JSONB NOT NULL DEFAULT '[]'::jsonb,
      description TEXT,
      specs JSONB NOT NULL DEFAULT '[]'::jsonb,
      brand TEXT,
      available BOOLEAN NOT NULL DEFAULT TRUE,
      source TEXT NOT NULL DEFAULT 'api',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`
    CREATE TABLE IF NOT EXISTS product_source_items (
      asin TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_niche TEXT,
      source_provider TEXT NOT NULL DEFAULT 'unknown',
      source_query TEXT,
      amazon_price NUMERIC(10,2) NOT NULL,
      ebay_price NUMERIC(10,2) NOT NULL,
      profit NUMERIC(10,2) NOT NULL,
      roi NUMERIC(8,2) NOT NULL,
      image_url TEXT,
      risk TEXT NOT NULL DEFAULT 'MEDIUM',
      sales_volume TEXT,
      rating NUMERIC(3,2),
      review_count INTEGER,
      total_score NUMERIC(12,2) NOT NULL DEFAULT 0,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_price_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_niche_score_idx ON product_source_items (source_niche, total_score DESC)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_score_idx ON product_source_items (total_score DESC)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_seen_idx ON product_source_items (last_seen_at DESC)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS intelligence_score NUMERIC(12,2)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS source_quality TEXT NOT NULL DEFAULT 'candidate'`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS last_intelligence_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS ebay_competitor_count INTEGER`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS listing_outcome_score NUMERIC(5,3) NOT NULL DEFAULT 1.000`.catch(() => {})
  // Sum of estimatedSoldQuantity across top competitor listings (eBay Browse getItem) —
  // the comparative "how fast do comparable items actually sell" demand signal.
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS ebay_sold_velocity INTEGER`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS ebay_sold_velocity_checked_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS best_seller_rank INTEGER`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS prime_eligible BOOLEAN`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS delivery_days_max INTEGER`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS fast_fulfillment BOOLEAN`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS fulfillment_summary TEXT`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS master_score NUMERIC(5,2)`.catch(() => {})
  // Phase 3 market-saturation columns — created here too so applySourceIntelligenceScores can
  // always reference inventory_quality_score / dup_* without a missing-column failure
  // (market-saturation also ensures these via ensureMarketSaturationColumns).
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS inventory_quality_score NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS dup_cluster_size INTEGER NOT NULL DEFAULT 1`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS dup_rank INTEGER NOT NULL DEFAULT 1`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_intelligence_idx ON product_source_items (intelligence_score DESC NULLS LAST)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_quality_idx ON product_source_items (active, source_quality, intelligence_score DESC NULLS LAST)`.catch(() => {})
}

export async function upsertProductSourceItems(inputs: SourceProductInput[]) {
  const normalized = inputs
    .map(normalizeProduct)
    .filter((product): product is NonNullable<ReturnType<typeof normalizeProduct>> => Boolean(product))

  if (normalized.length === 0) return 0
  await ensureProductSourceTables()

  const uniqueProductsByAsin = new Map<string, NonNullable<ReturnType<typeof normalizeProduct>>>()
  for (const product of normalized) {
    const current = uniqueProductsByAsin.get(product.asin)
    if (!current || (product.qualityScore || 0) > (current.qualityScore || 0)) {
      uniqueProductsByAsin.set(product.asin, product)
    }
  }

  const uniqueProducts = Array.from(uniqueProductsByAsin.values())
  const rows = uniqueProducts.map((product) => ({
    asin: product.asin,
    title: product.title,
    source_niche: product.sourceNiche || null,
    source_provider: product.sourceProvider,
    source_query: product.sourceQuery || null,
    amazon_price: product.amazonPrice.toFixed(2),
    ebay_price: product.ebayPrice.toFixed(2),
    profit: product.profit.toFixed(2),
    roi: product.roi.toFixed(2),
    image_url: product.imageUrl || null,
    risk: product.risk,
    sales_volume: product.salesVolume || null,
    rating: product._rating || null,
    review_count: product._numRatings || null,
    total_score: product.qualityScore || 0,
    master_score: product.masterScore ?? null,
    source_quality: product.sourceQuality === 'reject' ? 'reject' : 'candidate',
    raw: {
      images: product.images || [],
      features: product.features || [],
      description: product.description || '',
      specs: product.specs || [],
      sourceQuery: product.sourceQuery || null,
      raw: product.raw,
    },
  }))

  const chunkSize = 500
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize)
    await sql`
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS product(
          asin TEXT,
          title TEXT,
          source_niche TEXT,
          source_provider TEXT,
          master_score NUMERIC,
          source_quality TEXT,
          source_query TEXT,
          amazon_price NUMERIC,
          ebay_price NUMERIC,
          profit NUMERIC,
          roi NUMERIC,
          image_url TEXT,
          risk TEXT,
          sales_volume TEXT,
          rating NUMERIC,
          review_count INTEGER,
          total_score NUMERIC,
          raw JSONB
        )
      )
      INSERT INTO product_source_items (
        asin, title, source_niche, source_provider, source_query, amazon_price, ebay_price,
        profit, roi, image_url, risk, sales_volume, rating, review_count, total_score,
        master_score, source_quality, raw
      )
      SELECT
        asin, title, source_niche, source_provider, source_query, amazon_price, ebay_price,
        profit, roi, image_url, risk, sales_volume, rating, review_count, total_score,
        master_score, source_quality, raw
      FROM input
      ON CONFLICT (asin) DO UPDATE SET
        title = EXCLUDED.title,
        source_niche = COALESCE(EXCLUDED.source_niche, product_source_items.source_niche),
        source_provider = EXCLUDED.source_provider,
        source_query = COALESCE(EXCLUDED.source_query, product_source_items.source_query),
        amazon_price = EXCLUDED.amazon_price,
        ebay_price = EXCLUDED.ebay_price,
        profit = EXCLUDED.profit,
        roi = EXCLUDED.roi,
        image_url = COALESCE(EXCLUDED.image_url, product_source_items.image_url),
        risk = EXCLUDED.risk,
        sales_volume = COALESCE(EXCLUDED.sales_volume, product_source_items.sales_volume),
        rating = COALESCE(EXCLUDED.rating, product_source_items.rating),
        review_count = COALESCE(EXCLUDED.review_count, product_source_items.review_count),
        total_score = EXCLUDED.total_score,
        master_score = COALESCE(EXCLUDED.master_score, product_source_items.master_score),
        raw = product_source_items.raw || EXCLUDED.raw,
        source_quality = CASE
          WHEN product_source_items.source_quality = 'reject' THEN 'reject'
          WHEN EXCLUDED.source_quality = 'reject' THEN 'reject'
          ELSE COALESCE(product_source_items.source_quality, 'candidate')
        END,
        active = CASE
          WHEN product_source_items.source_quality = 'reject' THEN FALSE
          WHEN EXCLUDED.source_quality = 'reject' THEN FALSE
          ELSE TRUE
        END,
        last_seen_at = NOW(),
        last_price_checked_at = NOW()
    `
  }

  return uniqueProducts.length
}

export async function rebuildProductSourceFromCache(limit = 250) {
  await ensureProductSourceTables()
  const rows = await queryRows<ProductCacheRow>`
    SELECT niche, results
    FROM product_cache
    WHERE niche <> '__continuous_listing__'
    ORDER BY cached_at DESC
    LIMIT ${limit}
  `

  // Load rejected ASINs so we never re-introduce stale/mismatched products.
  // ASIN_MISMATCH, PRODUCT_UNAVAILABLE, and manual deactivations set source_quality='reject'.
  const rejectedRows = await queryRows<{ asin: string }>`
    SELECT asin FROM product_source_items
    WHERE source_quality = 'reject' OR active = FALSE
  `.catch(() => [])
  const rejectedSet = new Set(rejectedRows.map((row) => String(row.asin).toUpperCase()))

  const products: SourceProductInput[] = []
  for (const row of rows) {
    const rowProducts = Array.isArray(row.results) ? row.results : []
    for (const product of rowProducts) {
      if (rejectedSet.has(String(product.asin || '').toUpperCase())) continue
      products.push({
        ...product,
        sourceNiche: product.sourceNiche || row.niche,
        sourceProvider: 'cache',
      })
    }
  }
  return upsertProductSourceItems(products)
}

/**
 * Recompute master_score / intelligence_score for active pool rows that are unscored
 * (master_score IS NULL) or below floor (< MIN_MASTER_SCORE). Uses the same
 * computeProductScores logic the upsert path runs but skips the heavy upsert side-effects
 * (policy checks, image validation) so it can sweep thousands of rows quickly.
 *
 * Targets the 'silent failure' case where rows entered the pool before scoring was
 * deployed, or where a scoring run produced NaN/null. Without this backfill the
 * dashboard sort `ORDER BY intelligence_score DESC NULLS LAST` pushes unscored rows
 * to the bottom but still surfaces them when supply is thin.
 */
export async function backfillProductScores(options: { limit?: number; onlyUnscored?: boolean } = {}) {
  await ensureProductSourceTables()
  const limit = Math.max(1, Math.min(Math.floor(options.limit || 5000), 10000))
  const onlyUnscored = options.onlyUnscored !== false

  const rows = onlyUnscored
    ? await queryRows<ProductSourceRow & { master_score: number | null }>`
        SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price,
               psi.profit, psi.roi, psi.image_url, psi.risk, psi.sales_volume, psi.rating,
               psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
               psi.master_score
        FROM product_source_items psi
        WHERE psi.active = TRUE
          AND (psi.master_score IS NULL OR psi.master_score < ${MIN_MASTER_SCORE})
        ORDER BY psi.last_seen_at DESC
        LIMIT ${limit}
      `.catch(() => [])
    : await queryRows<ProductSourceRow & { master_score: number | null }>`
        SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price,
               psi.profit, psi.roi, psi.image_url, psi.risk, psi.sales_volume, psi.rating,
               psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
               psi.master_score
        FROM product_source_items psi
        WHERE psi.active = TRUE
        ORDER BY psi.last_seen_at DESC
        LIMIT ${limit}
      `.catch(() => [])

  let updated = 0, skipped = 0, deactivated = 0

  for (const row of rows) {
    const raw = row.raw || {}
    const product: SourceEngineProduct = {
      asin: row.asin,
      title: row.title,
      amazonPrice: parseNumber(row.amazon_price),
      ebayPrice: parseNumber(row.ebay_price),
      profit: parseNumber(row.profit),
      roi: parseNumber(row.roi),
      imageUrl: row.image_url || undefined,
      images: Array.isArray(raw.images) ? raw.images as string[] : undefined,
      features: Array.isArray(raw.features) ? raw.features as string[] : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      specs: Array.isArray(raw.specs) ? raw.specs as Array<[string, string]> : undefined,
      sourceNiche: row.source_niche || undefined,
      sourceQuality: row.source_quality || undefined,
      salesVolume: row.sales_volume || undefined,
      risk: row.risk || 'MEDIUM',
      _rating: parseNumber(row.rating),
      _numRatings: Math.round(parseNumber(row.review_count)),
    }

    const scores = computeProductScores(product)
    if (!Number.isFinite(scores.masterScore)) { skipped++; continue }

    // Below floor → deactivate so the pool stays clean. This is the same auto-reject
    // logic upsertProductSourceItems applies on insert.
    if (scores.masterScore < MIN_MASTER_SCORE) {
      await sql`
        UPDATE product_source_items
        SET active = FALSE,
            source_quality = 'reject',
            master_score = ${scores.masterScore},
            intelligence_score = ${scores.legacyScore},
            last_intelligence_at = NOW()
        WHERE asin = ${row.asin}
      `.catch(() => {})
      deactivated++
      continue
    }

    await sql`
      UPDATE product_source_items
      SET master_score = ${scores.masterScore},
          intelligence_score = ${scores.legacyScore},
          last_intelligence_at = NOW()
      WHERE asin = ${row.asin}
    `.catch(() => {})
    updated++
  }

  return { scanned: rows.length, updated, deactivated, skipped }
}

export async function deactivateUnavailableProductSourcesFromCache() {
  await ensureProductSourceTables()
  const rows = await queryRows<{ asin: string }>`
    UPDATE product_source_items psi
    SET active = FALSE,
        last_seen_at = NOW()
    FROM amazon_product_cache apc
    WHERE UPPER(apc.asin) = UPPER(psi.asin)
      AND apc.available = FALSE
      AND psi.active = TRUE
    RETURNING psi.asin
  `.catch(() => [])
  return rows.length
}

export async function repriceProductSourceItems(limit = 2500) {
  await ensureProductSourceTables()
  const rows = await queryRows<ProductSourceRow>`
    SELECT asin, title, source_niche, amazon_price, ebay_price, profit, roi, image_url, risk,
           sales_volume, rating, review_count, total_score, intelligence_score, source_quality, raw
    FROM product_source_items
    WHERE active = TRUE
    ORDER BY last_seen_at DESC
    LIMIT ${limit}
  `
  const products: SourceProductInput[] = rows.map((row) => {
    const raw = row.raw || {}
    return {
      asin: row.asin,
      title: row.title,
      amazonPrice: parseNumber(row.amazon_price),
      imageUrl: row.image_url || undefined,
      images: Array.isArray(raw.images) ? raw.images as string[] : undefined,
      features: Array.isArray(raw.features) ? raw.features as string[] : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      specs: Array.isArray(raw.specs) ? raw.specs as Array<[string, string]> : undefined,
      sourceNiche: row.source_niche || undefined,
      sourceProvider: 'repricer',
      raw,
      salesVolume: row.sales_volume || undefined,
      _rating: parseNumber(row.rating),
      _numRatings: Math.round(parseNumber(row.review_count)),
    }
  })
  return upsertProductSourceItems(products)
}

export async function refreshProductSourcePrices(options: { limit?: number; staleDays?: number } = {}) {
  await ensureProductSourceTables()
  const limit = Math.max(1, Math.min(Math.floor(options.limit || 300), 500))
  const staleDays = Math.max(1, Math.min(Math.floor(options.staleDays || 5), 90))

  const rows = await queryRows<ProductSourceRow & { asin: string }>`
    SELECT asin, title, source_niche, amazon_price, ebay_price, profit, roi, image_url, risk,
           sales_volume, rating, review_count, total_score, intelligence_score, source_quality, raw
    FROM product_source_items
    WHERE active = TRUE
      AND last_seen_at < NOW() - (${staleDays} * INTERVAL '1 day')
    ORDER BY last_seen_at ASC
    LIMIT ${limit}
  `

  if (rows.length === 0) return { updated: 0, unchanged: 0, failed: 0 }

  const rapidKey = getRapidApiKey()
  let updated = 0, unchanged = 0, failed = 0
  const BATCH = 5

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    await Promise.all(batch.map(async (row) => {
      try {
        let freshPrice: number | null = null

        if (rapidKey) {
          const res = await fetch(
            `https://real-time-amazon-data.p.rapidapi.com/product-details?asin=${row.asin}&country=US`,
            { headers: { 'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com', 'x-rapidapi-key': rapidKey }, signal: AbortSignal.timeout(6000) }
          ).catch(() => null)
          if (res?.ok) {
            const json = await res.json()
            const data = json?.data ?? json
            if (!String(data?.message || '').match(/limit|quota|exceed/)) {
              const availability = String(data.product_availability || '').toLowerCase()
              if (availability === 'currently unavailable') {
                // Product is explicitly unavailable — deactivate from pool immediately
                await sql`UPDATE product_source_items SET active = FALSE, last_seen_at = NOW() WHERE asin = ${row.asin}`.catch(() => {})
                failed += 1
                return
              }
              const raw = data.product_price || data.price
              const p = typeof raw === 'number' ? raw : parseFloat(String(raw || '').replace(/[^0-9.]/g, ''))
              if (p > 0) freshPrice = p
            }
          }
        }

        // Fall back to direct Amazon scrape only for fresh-price discovery — NEVER for
        // deactivation. The own-scraper has a ~90% false-positive rate on availability
        // due to Amazon bot detection (returns no price / available=false when bot-blocked).
        // We trusted that signal in the past, causing massive false deactivations of
        // perfectly-good products and the user-visible niche-count attrition leak.
        //
        // Trust ONLY RapidAPI's "currently unavailable" signal for deactivation (handled
        // above at line ~755). If scrape returns invalid data here, just skip this product
        // for this cycle — RapidAPI will reach it eventually and deactivate if warranted.
        if (!freshPrice) {
          try {
            const scraped = await scrapeAmazonProduct(row.asin)
            if (scraped && scraped.available && scraped.price > 0) {
              freshPrice = scraped.price
            }
            // If scrape returned not-available or no price, skip silently. Do not deactivate.
          } catch { /* scraper failed — skip */ }
        }

        if (!freshPrice) return void (failed += 1)

        const oldPrice = parseNumber(row.amazon_price)
        // Only update if price changed by more than 2% to avoid noise
        if (Math.abs(freshPrice - oldPrice) / Math.max(oldPrice, 1) < 0.02) {
          unchanged += 1
          // Still touch last_seen_at so it doesn't keep getting re-checked
          await sql`UPDATE product_source_items SET last_seen_at = NOW() WHERE asin = ${row.asin}`.catch(() => {})
          return
        }

        // Price changed — recalculate eBay price using the live pricing engine
        const newEbayPrice = getRecommendedEbayPrice(freshPrice, EBAY_DEFAULT_FEE_RATE)
        const metrics = getListingMetrics(freshPrice, newEbayPrice, EBAY_DEFAULT_FEE_RATE)
        await sql`
          UPDATE product_source_items
          SET amazon_price = ${freshPrice},
              ebay_price   = ${newEbayPrice},
              profit       = ${metrics.profit},
              roi          = ${metrics.roi},
              last_seen_at = NOW()
          WHERE asin = ${row.asin}
        `.catch(() => {})
        updated += 1
      } catch {
        failed += 1
      }
    }))
  }

  return { updated, unchanged, failed }
}

export async function loadProductSourceProducts(options: { niche?: string | null; limit?: number; excludeAsins?: Set<string> | string[]; forUserId?: number | string | null } = {}) {
  await ensureProductSourceTables()
  const forUserIdParam = options.forUserId !== undefined && options.forUserId !== null && Number.isFinite(Number(options.forUserId))
    ? Number(options.forUserId)
    : null
  const limit = Math.max(1, Math.min(900, options.limit || 120))
  // Fetch a MUCH wider candidate window than `limit` before the JS quality filters
  // run (stale-title, distinct-images, policy, economics). Those filters can reject
  // 70-85% of the top-ranked rows, so a 3x window (e.g. 270 rows for a 90 request)
  // left only ~14 publish-ready — the queue could never refill to 30 even though the
  // pool has thousands ready. A 12x window (capped at 2500) gives the filters enough
  // raw candidates that 30+ survive in a single fetch. (2026-06-06)
  const rowLimit = Math.min(2500, Math.max(limit, limit * 12))
  // Build a normalized exclude set from either a Set or array of ASINs.
  // When excludeAsins are supplied we fetch extra rows (up to rowLimit + excludeCount)
  // so the post-filter result still has at least `limit` candidates.
  const excludeSet: Set<string> = options.excludeAsins
    ? (options.excludeAsins instanceof Set
        ? new Set(Array.from(options.excludeAsins).map((a) => a.toUpperCase()))
        : new Set(options.excludeAsins.map((a) => a.toUpperCase())))
    : new Set<string>()
  const excludeCount = excludeSet.size
  // Fetch enough extra rows so there are still `limit` left after excluding.
  const fetchLimit = Math.min(2500, rowLimit + excludeCount)
  try {
    const niche = options.niche?.trim()
    const excludeArray = excludeCount > 0 ? Array.from(excludeSet) : null
    const rows = niche
      ? (excludeArray
          ? await queryRows<ProductSourceRow>`
              SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price, psi.profit, psi.roi, psi.image_url, psi.risk,
                     psi.sales_volume, psi.rating, psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
                     apc.title AS cached_title, apc.amazon_price AS cached_amazon_price, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.prime_eligible AS cached_prime_eligible,
                     apc.delivery_days_max AS cached_delivery_days_max, apc.fast_fulfillment AS cached_fast_fulfillment,
                     apc.fulfillment_summary AS cached_fulfillment_summary, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score, psi.ebay_sold_velocity
              FROM product_source_items psi
              LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
              WHERE psi.active = TRUE
                AND psi.source_niche = ${niche}
                AND psi.profit >= 4
                AND psi.roi >= 25
                AND psi.risk <> 'HIGH'
                AND psi.image_url IS NOT NULL
                AND psi.image_url <> ''
                AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
                AND COALESCE(apc.available, TRUE) <> FALSE
                AND apc.fast_fulfillment IS DISTINCT FROM FALSE
                AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
                -- HARD SATURATION GATE (Lever 1): skip products with >50 known eBay
                -- competitors so we stop offering listings that get crushed on price.
                -- NULL is permissive (data backfills via the competition cron over ~24h).
                AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
                -- RULE C — Cost-to-market ratio. Skip if Amazon cost >= 1.65x eBay min.
                -- NULL is permissive while competitor data is still enriching.
                AND (psi.ebay_competitor_min_price IS NULL
                     OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
                -- RULE E — Title-pattern blocklist (2026-06-02). Blocks oversized items
                -- (couch/sofa/TV), Amazon-owned brands (kindle/echo/fire), and apparel
                -- (until #28 Department auto-fill ships). Using explicit ILIKE chain
                -- because LIKE ANY(text[]) array binding wasn't reliably filtering.
                AND (psi.title IS NULL OR (
                  psi.title NOT ILIKE '%television%' AND psi.title NOT ILIKE '% tv %'
                  AND psi.title NOT ILIKE '%couch%' AND psi.title NOT ILIKE '%sofa%'
                  AND psi.title NOT ILIKE '%mattress%' AND psi.title NOT ILIKE '%recliner%'
                  AND psi.title NOT ILIKE '%refrigerator%' AND psi.title NOT ILIKE '%treadmill%'
                  AND psi.title NOT ILIKE '%kindle%' AND psi.title NOT ILIKE '%echo dot%'
                  AND psi.title NOT ILIKE '%fire tv%' AND psi.title NOT ILIKE '%ring doorbell%'
                  AND psi.title NOT ILIKE '%t-shirt%' AND psi.title NOT ILIKE '%hoodie%'
                  AND psi.title NOT ILIKE '%pants%' AND psi.title NOT ILIKE '%jeans%'
                  AND psi.title NOT ILIKE '%dress%' AND psi.title NOT ILIKE '%halter%'
                  AND psi.title NOT ILIKE '%tank top%' AND psi.title NOT ILIKE '%jacket%'
                  AND psi.title NOT ILIKE '%leggings%' AND psi.title NOT ILIKE '%skirt%'
                  AND psi.title NOT ILIKE '%blouse%' AND psi.title NOT ILIKE '%bikini%'
                  AND psi.title NOT ILIKE '%swimsuit%' AND psi.title NOT ILIKE '%sweater%'
                  AND psi.title NOT ILIKE '%cardigan%'
                ))
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                AND UPPER(psi.asin) <> ALL(${excludeArray}::text[])
                -- Duplicate scope is PER ACCOUNT (2026-07-13): only exclude ASINs the
                -- requesting user has live. With no forUserId (shared snapshot), skip the
                -- exclusion — each caller re-filters against its own user's listings.
                AND (${forUserIdParam}::int IS NULL OR NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE la.user_id = ${forUserIdParam}::int
                    AND UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                ))
              ORDER BY
                -- Priority 1: cached + ≥2 images sit at the top so dashboard top-30 is all list-ready
                (CASE WHEN apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2 THEN 0 ELSE 1 END),
                psi.master_score DESC NULLS LAST,
                psi.intelligence_score DESC NULLS LAST,
                psi.total_score DESC,
                psi.last_seen_at DESC
              LIMIT ${fetchLimit}
            `
          : await queryRows<ProductSourceRow>`
              SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price, psi.profit, psi.roi, psi.image_url, psi.risk,
                     psi.sales_volume, psi.rating, psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
                     apc.title AS cached_title, apc.amazon_price AS cached_amazon_price, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.prime_eligible AS cached_prime_eligible,
                     apc.delivery_days_max AS cached_delivery_days_max, apc.fast_fulfillment AS cached_fast_fulfillment,
                     apc.fulfillment_summary AS cached_fulfillment_summary, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score, psi.ebay_sold_velocity
              FROM product_source_items psi
              LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
              WHERE psi.active = TRUE
                AND psi.source_niche = ${niche}
                AND psi.profit >= 4
                AND psi.roi >= 25
                AND psi.risk <> 'HIGH'
                AND psi.image_url IS NOT NULL
                AND psi.image_url <> ''
                AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
                AND COALESCE(apc.available, TRUE) <> FALSE
                AND apc.fast_fulfillment IS DISTINCT FROM FALSE
                AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
                -- HARD SATURATION GATE (Lever 1): skip products with >50 known eBay
                -- competitors so we stop offering listings that get crushed on price.
                -- NULL is permissive (data backfills via the competition cron over ~24h).
                AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
                -- RULE C — Cost-to-market ratio. Skip if Amazon cost >= 1.65x eBay min.
                -- NULL is permissive while competitor data is still enriching.
                AND (psi.ebay_competitor_min_price IS NULL
                     OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
                -- RULE E — Title-pattern blocklist (2026-06-02). Blocks oversized items
                -- (couch/sofa/TV), Amazon-owned brands (kindle/echo/fire), and apparel
                -- (until #28 Department auto-fill ships). Using explicit ILIKE chain
                -- because LIKE ANY(text[]) array binding wasn't reliably filtering.
                AND (psi.title IS NULL OR (
                  psi.title NOT ILIKE '%television%' AND psi.title NOT ILIKE '% tv %'
                  AND psi.title NOT ILIKE '%couch%' AND psi.title NOT ILIKE '%sofa%'
                  AND psi.title NOT ILIKE '%mattress%' AND psi.title NOT ILIKE '%recliner%'
                  AND psi.title NOT ILIKE '%refrigerator%' AND psi.title NOT ILIKE '%treadmill%'
                  AND psi.title NOT ILIKE '%kindle%' AND psi.title NOT ILIKE '%echo dot%'
                  AND psi.title NOT ILIKE '%fire tv%' AND psi.title NOT ILIKE '%ring doorbell%'
                  AND psi.title NOT ILIKE '%t-shirt%' AND psi.title NOT ILIKE '%hoodie%'
                  AND psi.title NOT ILIKE '%pants%' AND psi.title NOT ILIKE '%jeans%'
                  AND psi.title NOT ILIKE '%dress%' AND psi.title NOT ILIKE '%halter%'
                  AND psi.title NOT ILIKE '%tank top%' AND psi.title NOT ILIKE '%jacket%'
                  AND psi.title NOT ILIKE '%leggings%' AND psi.title NOT ILIKE '%skirt%'
                  AND psi.title NOT ILIKE '%blouse%' AND psi.title NOT ILIKE '%bikini%'
                  AND psi.title NOT ILIKE '%swimsuit%' AND psi.title NOT ILIKE '%sweater%'
                  AND psi.title NOT ILIKE '%cardigan%'
                ))
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                -- Duplicate scope is PER ACCOUNT (2026-07-13): only exclude ASINs the
                -- requesting user has live. With no forUserId (shared snapshot), skip the
                -- exclusion — each caller re-filters against its own user's listings.
                AND (${forUserIdParam}::int IS NULL OR NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE la.user_id = ${forUserIdParam}::int
                    AND UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                ))
              ORDER BY
                -- Priority 1: cached + ≥2 images sit at the top so dashboard top-30 is all list-ready
                (CASE WHEN apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2 THEN 0 ELSE 1 END),
                psi.master_score DESC NULLS LAST,
                psi.intelligence_score DESC NULLS LAST,
                psi.total_score DESC,
                psi.last_seen_at DESC
              LIMIT ${fetchLimit}
            `)
      : (excludeArray
          ? await queryRows<ProductSourceRow>`
              SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price, psi.profit, psi.roi, psi.image_url, psi.risk,
                     psi.sales_volume, psi.rating, psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
                     apc.title AS cached_title, apc.amazon_price AS cached_amazon_price, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.prime_eligible AS cached_prime_eligible,
                     apc.delivery_days_max AS cached_delivery_days_max, apc.fast_fulfillment AS cached_fast_fulfillment,
                     apc.fulfillment_summary AS cached_fulfillment_summary, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score, psi.ebay_sold_velocity
              FROM product_source_items psi
              LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
              WHERE psi.active = TRUE
                AND psi.profit >= 4
                AND psi.roi >= 25
                AND psi.risk <> 'HIGH'
                AND psi.image_url IS NOT NULL
                AND psi.image_url <> ''
                AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
                AND COALESCE(apc.available, TRUE) <> FALSE
                AND apc.fast_fulfillment IS DISTINCT FROM FALSE
                AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
                -- HARD SATURATION GATE (Lever 1): skip products with >50 known eBay
                -- competitors so we stop offering listings that get crushed on price.
                -- NULL is permissive (data backfills via the competition cron over ~24h).
                AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
                -- RULE C — Cost-to-market ratio. Skip if Amazon cost >= 1.65x eBay min.
                -- NULL is permissive while competitor data is still enriching.
                AND (psi.ebay_competitor_min_price IS NULL
                     OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
                -- RULE E — Title-pattern blocklist (2026-06-02). Blocks oversized items
                -- (couch/sofa/TV), Amazon-owned brands (kindle/echo/fire), and apparel
                -- (until #28 Department auto-fill ships). Using explicit ILIKE chain
                -- because LIKE ANY(text[]) array binding wasn't reliably filtering.
                AND (psi.title IS NULL OR (
                  psi.title NOT ILIKE '%television%' AND psi.title NOT ILIKE '% tv %'
                  AND psi.title NOT ILIKE '%couch%' AND psi.title NOT ILIKE '%sofa%'
                  AND psi.title NOT ILIKE '%mattress%' AND psi.title NOT ILIKE '%recliner%'
                  AND psi.title NOT ILIKE '%refrigerator%' AND psi.title NOT ILIKE '%treadmill%'
                  AND psi.title NOT ILIKE '%kindle%' AND psi.title NOT ILIKE '%echo dot%'
                  AND psi.title NOT ILIKE '%fire tv%' AND psi.title NOT ILIKE '%ring doorbell%'
                  AND psi.title NOT ILIKE '%t-shirt%' AND psi.title NOT ILIKE '%hoodie%'
                  AND psi.title NOT ILIKE '%pants%' AND psi.title NOT ILIKE '%jeans%'
                  AND psi.title NOT ILIKE '%dress%' AND psi.title NOT ILIKE '%halter%'
                  AND psi.title NOT ILIKE '%tank top%' AND psi.title NOT ILIKE '%jacket%'
                  AND psi.title NOT ILIKE '%leggings%' AND psi.title NOT ILIKE '%skirt%'
                  AND psi.title NOT ILIKE '%blouse%' AND psi.title NOT ILIKE '%bikini%'
                  AND psi.title NOT ILIKE '%swimsuit%' AND psi.title NOT ILIKE '%sweater%'
                  AND psi.title NOT ILIKE '%cardigan%'
                ))
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                AND UPPER(psi.asin) <> ALL(${excludeArray}::text[])
                -- Duplicate scope is PER ACCOUNT (2026-07-13): only exclude ASINs the
                -- requesting user has live. With no forUserId (shared snapshot), skip the
                -- exclusion — each caller re-filters against its own user's listings.
                AND (${forUserIdParam}::int IS NULL OR NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE la.user_id = ${forUserIdParam}::int
                    AND UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                ))
              ORDER BY
                -- Priority 1: cached + ≥2 images sit at the top so dashboard top-30 is all list-ready
                (CASE WHEN apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2 THEN 0 ELSE 1 END),
                psi.master_score DESC NULLS LAST,
                psi.intelligence_score DESC NULLS LAST,
                psi.total_score DESC,
                psi.last_seen_at DESC
              LIMIT ${fetchLimit}
            `
          : await queryRows<ProductSourceRow>`
              SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price, psi.profit, psi.roi, psi.image_url, psi.risk,
                     psi.sales_volume, psi.rating, psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
                     apc.title AS cached_title, apc.amazon_price AS cached_amazon_price, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.prime_eligible AS cached_prime_eligible,
                     apc.delivery_days_max AS cached_delivery_days_max, apc.fast_fulfillment AS cached_fast_fulfillment,
                     apc.fulfillment_summary AS cached_fulfillment_summary, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score, psi.ebay_sold_velocity
              FROM product_source_items psi
              LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
              WHERE psi.active = TRUE
                AND psi.profit >= 4
                AND psi.roi >= 25
                AND psi.risk <> 'HIGH'
                AND psi.image_url IS NOT NULL
                AND psi.image_url <> ''
                AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
                AND COALESCE(apc.available, TRUE) <> FALSE
                AND apc.fast_fulfillment IS DISTINCT FROM FALSE
                AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
                -- HARD SATURATION GATE (Lever 1): skip products with >50 known eBay
                -- competitors so we stop offering listings that get crushed on price.
                -- NULL is permissive (data backfills via the competition cron over ~24h).
                AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
                -- RULE C — Cost-to-market ratio. Skip if Amazon cost >= 1.65x eBay min.
                -- NULL is permissive while competitor data is still enriching.
                AND (psi.ebay_competitor_min_price IS NULL
                     OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
                -- RULE E — Title-pattern blocklist (2026-06-02). Blocks oversized items
                -- (couch/sofa/TV), Amazon-owned brands (kindle/echo/fire), and apparel
                -- (until #28 Department auto-fill ships). Using explicit ILIKE chain
                -- because LIKE ANY(text[]) array binding wasn't reliably filtering.
                AND (psi.title IS NULL OR (
                  psi.title NOT ILIKE '%television%' AND psi.title NOT ILIKE '% tv %'
                  AND psi.title NOT ILIKE '%couch%' AND psi.title NOT ILIKE '%sofa%'
                  AND psi.title NOT ILIKE '%mattress%' AND psi.title NOT ILIKE '%recliner%'
                  AND psi.title NOT ILIKE '%refrigerator%' AND psi.title NOT ILIKE '%treadmill%'
                  AND psi.title NOT ILIKE '%kindle%' AND psi.title NOT ILIKE '%echo dot%'
                  AND psi.title NOT ILIKE '%fire tv%' AND psi.title NOT ILIKE '%ring doorbell%'
                  AND psi.title NOT ILIKE '%t-shirt%' AND psi.title NOT ILIKE '%hoodie%'
                  AND psi.title NOT ILIKE '%pants%' AND psi.title NOT ILIKE '%jeans%'
                  AND psi.title NOT ILIKE '%dress%' AND psi.title NOT ILIKE '%halter%'
                  AND psi.title NOT ILIKE '%tank top%' AND psi.title NOT ILIKE '%jacket%'
                  AND psi.title NOT ILIKE '%leggings%' AND psi.title NOT ILIKE '%skirt%'
                  AND psi.title NOT ILIKE '%blouse%' AND psi.title NOT ILIKE '%bikini%'
                  AND psi.title NOT ILIKE '%swimsuit%' AND psi.title NOT ILIKE '%sweater%'
                  AND psi.title NOT ILIKE '%cardigan%'
                ))
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                -- Duplicate scope is PER ACCOUNT (2026-07-13): only exclude ASINs the
                -- requesting user has live. With no forUserId (shared snapshot), skip the
                -- exclusion — each caller re-filters against its own user's listings.
                AND (${forUserIdParam}::int IS NULL OR NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE la.user_id = ${forUserIdParam}::int
                    AND UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                ))
              ORDER BY
                -- Priority 1: cached + ≥2 images sit at the top so dashboard top-30 is all list-ready
                (CASE WHEN apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2 THEN 0 ELSE 1 END),
                psi.master_score DESC NULLS LAST,
                psi.intelligence_score DESC NULLS LAST,
                psi.total_score DESC,
                psi.last_seen_at DESC
              LIMIT ${fetchLimit}
            `)
    const allProducts = rows.map(rowToProduct)
    const staleSamples: string[] = []
    const afterFreshMapping = allProducts.filter((product) => {
      const score = getTitleMatchScore(product.title, product.cachedTitle)
      // Loosened 0.45 -> 0.18 (2026-06-07). A 45% word-overlap requirement was dropping
      // 375 of 531 eligible products (71%) — legit items whose stored title and cached
      // Amazon title are just worded differently (truncated vs full, brand prefix, etc.).
      // True ASIN cross-mapping is already caught at LIST time (ASIN_MISMATCH + auto-
      // deactivate), so this queue-time gate only needs to catch egregious mismatches.
      const stale = Boolean(product.cachedTitle && score < 0.18)
      if (stale && staleSamples.length < 5) {
        staleSamples.push(`${product.asin}: ${score.toFixed(2)}`)
      }
      return !stale
    })

    const sparseImageSamples: string[] = []
    const afterDistinctImages = afterFreshMapping.filter((product) => {
      const ok = hasAtLeastDistinctImages(product, 2)
      if (!ok && sparseImageSamples.length < 5) {
        sparseImageSamples.push(product.asin)
      }
      return ok
    })

    const afterWeakTitle = afterDistinctImages.filter((product) => !isWeakListingTitle(product.title))
    // RULE F — Apply the EXACT same listing-policy check the eBay listing route uses
    // (lib/listing-policy.ts). This guarantees the source pool matches what list-product
    // will actually accept. Catches oversized/Amazon-brand/apparel matches that survived
    // Rule E's title-only SQL filter because they matched via niche or description.
    const blockedSamples: string[] = []
    const afterPolicy = afterWeakTitle.filter((product) => {
      // Check BOTH the stored title (psi.title) AND the freshly-scraped Amazon title
      // (cached_title from amazon_product_cache). Amazon may have updated the product
      // (e.g., ASIN reassigned from "Tool" to "Couch"), and we want either match to block.
      const combinedTitle = product.cachedTitle && product.cachedTitle !== product.title
        ? `${product.title} ${product.cachedTitle}`
        : product.title
      const flags = getListingPolicyFlags({
        title: combinedTitle,
        niche: product.sourceNiche || null,
      })
      const blocked = hasBlockedListingPolicyFlag(flags)
      if (blocked && blockedSamples.length < 5) {
        blockedSamples.push(`${product.asin}: ${flags.find((f) => f.severity === 'block')?.match || '?'}`)
      }
      return !blocked
    })
    // ECONOMICS ALIGNMENT (2026-06-06): mirror the client-side getBulkPreflightIssue
    // economics checks (dashboard/utils.ts) so the backend only serves products the
    // browser will ALSO count as publish-ready. Previously the backend passed products
    // whose STORED psi.profit was fine, but the freshly-recomputed metrics.profit on the
    // product object came in under the $3 floor (or had an invalid price) — those passed
    // the backend, failed the client preflight, and made the ready count settle below 30
    // every batch. Filtering here means fetched count == client-ready count, so the queue
    // reliably fills to 30.
    const afterEconomics = afterPolicy.filter((product) =>
      Number.isFinite(product.amazonPrice) && product.amazonPrice > 0 &&
      Number.isFinite(product.ebayPrice) && product.ebayPrice > 0 &&
      product.available !== false &&
      // TRUE net-profit floor (2026-06-07): take-home after eBay fees + Promoted ads +
      // Amazon sales tax must clear MIN_NET_PROFIT. Replaces the gross profit>=3 check
      // that let break-even items (e.g. the $13 camera netting $0.57) into the queue.
      getNetProfit(product.amazonPrice, product.ebayPrice, { feeRate: EBAY_DEFAULT_FEE_RATE }) >= MIN_NET_PROFIT
    )
    console.info('[source-engine] Rule F filter result', JSON.stringify({
      total: allProducts.length,
      afterFreshMapping: afterFreshMapping.length,
      staleMappingDrops: allProducts.length - afterFreshMapping.length,
      staleSamples,
      afterDistinctImages: afterDistinctImages.length,
      sparseImageDrops: afterFreshMapping.length - afterDistinctImages.length,
      sparseImageSamples,
      afterWeakTitle: afterWeakTitle.length,
      afterPolicy: afterPolicy.length,
      blockedByPolicy: afterWeakTitle.length - afterPolicy.length,
      blockedSamples,
      afterEconomics: afterEconomics.length,
      economicsDrops: afterPolicy.length - afterEconomics.length,
    }))
    return afterEconomics
      .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
      .slice(0, limit)
  } catch {
    return []
  }
}
