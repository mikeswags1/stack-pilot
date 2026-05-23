import { queryRows, sql } from '@/lib/db'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getRecommendedEbayPrice, getTargetRoi } from '@/lib/listing-pricing'
import { getListingPolicyFlags, hasBlockedListingPolicyFlag } from '@/lib/listing-policy'
import { scrapeAmazonProduct } from '@/lib/amazon-scrape'
import { getRapidApiKey } from '@/lib/rapidapi'
import { getListingTitleQuality, isWeakListingTitle } from '@/lib/listing-quality'
import { getSourcingTrendMultiplier, getSourcingTrendSignals } from '@/lib/source-niches'

/** Minimum master score for a product to enter the active pool. Below this = auto-reject. */
const MIN_MASTER_SCORE = 38

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
  _rating?: number
  _numRatings?: number
  bestSellerRank?: number
  ebayCompetitorCount?: number
  listingOutcomeScore?: number
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
  cached_primary_image?: string | null
  cached_images?: string[] | null
  cached_features?: string[] | null
  cached_description?: string | null
  cached_specs?: Array<[string, string]> | null
  cached_available?: boolean | null
  cached_bsr?: number | null
  ebay_competitor_count?: number | null
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
  const amazonPrice = parseNumber(row.amazon_price)
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
    title: row.title,
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
    sourceQuality: row.cached_available === true && images.length >= 2 && row.source_quality !== 'reject' ? 'ready' : row.source_quality || undefined,
    // If no amazon_product_cache row exists (LEFT JOIN → null), assume available.
    // Only explicitly mark unavailable when the cache confirms available = FALSE.
    // Using undefined previously caused isPublishReadyProduct (available === true check)
    // to reject every pool product lacking a cache entry, shrinking publishReadyCount to 0.
    available: row.cached_available ?? true,
    _rating: parseNumber(row.rating),
    _numRatings: Math.round(parseNumber(row.review_count)),
    bestSellerRank: row.cached_bsr ?? undefined,
    ebayCompetitorCount: row.ebay_competitor_count !== null && row.ebay_competitor_count !== undefined ? Number(row.ebay_competitor_count) : undefined,
    listingOutcomeScore: row.listing_outcome_score !== null && row.listing_outcome_score !== undefined ? parseNumber(row.listing_outcome_score) : undefined,
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
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS best_seller_rank INTEGER`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS master_score NUMERIC(5,2)`.catch(() => {})
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

export async function loadProductSourceProducts(options: { niche?: string | null; limit?: number; excludeAsins?: Set<string> | string[] } = {}) {
  await ensureProductSourceTables()
  const limit = Math.max(1, Math.min(900, options.limit || 120))
  const rowLimit = Math.min(2500, Math.max(limit, limit * 3))
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
                     apc.title AS cached_title, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score
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
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                AND UPPER(psi.asin) <> ALL(${excludeArray}::text[])
                AND NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                )
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
                     apc.title AS cached_title, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score
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
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                AND NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                )
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
                     apc.title AS cached_title, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score
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
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                AND UPPER(psi.asin) <> ALL(${excludeArray}::text[])
                AND NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                )
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
                     apc.title AS cached_title, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                     apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                     apc.available AS cached_available, apc.best_seller_rank AS cached_bsr,
                     psi.ebay_competitor_count, psi.listing_outcome_score
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
                -- HARD GATE: only return products that are FULLY enriched (cache + 2+ images).
                -- This matches user's mental model: dashboard = pre-vetted, list-ready pool.
                -- Unenriched products are kept in DB but hidden from dashboard until cron enriches them.
                AND apc.asin IS NOT NULL
                AND jsonb_typeof(apc.images) = 'array'
                AND jsonb_array_length(apc.images) >= 2
                AND NOT EXISTS (
                  SELECT 1 FROM listed_asins la
                  WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL
                )
              ORDER BY
                -- Priority 1: cached + ≥2 images sit at the top so dashboard top-30 is all list-ready
                (CASE WHEN apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2 THEN 0 ELSE 1 END),
                psi.master_score DESC NULLS LAST,
                psi.intelligence_score DESC NULLS LAST,
                psi.total_score DESC,
                psi.last_seen_at DESC
              LIMIT ${fetchLimit}
            `)
    return rows
      .map(rowToProduct)
      .filter((product) => !isWeakListingTitle(product.title))
      .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
      .slice(0, limit)
  } catch {
    return []
  }
}
