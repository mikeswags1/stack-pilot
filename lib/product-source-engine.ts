import { queryRows, sql } from '@/lib/db'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getRecommendedEbayPrice } from '@/lib/listing-pricing'
import { getListingPolicyFlags, hasBlockedListingPolicyFlag } from '@/lib/listing-policy'
import { scrapeAmazonProduct } from '@/lib/amazon-scrape'
import { getRapidApiKey } from '@/lib/rapidapi'
import { isWeakListingTitle } from '@/lib/listing-quality'
import { getSourcingTrendMultiplier, getSourcingTrendSignals } from '@/lib/source-niches'

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
  available?: boolean
  _rating?: number
  _numRatings?: number
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

function scoreProduct(product: SourceEngineProduct) {
  const rating = product._rating && product._rating > 0 ? product._rating : 3.8
  const reviews = product._numRatings || 0
  const sales = parseSales(product.salesVolume)
  const margin = product.ebayPrice > 0 ? (product.profit / product.ebayPrice) * 100 : 0
  const imageCount = Math.max(product.images?.length || 0, product.imageUrl ? 1 : 0)
  const trendSignals = getSourcingTrendSignals({
    title: product.title,
    sourceNiche: product.sourceNiche,
    price: product.amazonPrice,
    imageCount,
  })
  const demandScore =
    Math.log10(sales + 10) * 16 +
    Math.log10(reviews + 25) * 15 +
    clamp(rating / 5, 0.65, 1.05) * 19
  const profitScore = clamp(product.profit, 0, 120) * 1.02
  const roiScore = clamp(product.roi / 65, 0.38, 1.85) * 26
  const marginScore = clamp(margin / 30, 0.38, 1.55) * 19
  const reviewTrust = reviews >= 80 ? 1.08 : reviews >= 35 ? 1.04 : reviews < 8 ? 0.92 : 1
  const priceSweetSpot = product.amazonPrice >= 12 && product.amazonPrice <= 120 ? 18 : product.amazonPrice > 180 ? 7 : 12
  const riskPenalty = product.risk === 'HIGH' ? 0.72 : product.risk === 'MEDIUM' ? 0.9 : 1
  const imageBoost = imageCount >= 4 ? 12 : imageCount >= 2 ? 8 : product.imageUrl ? 3 : -10
  const logisticsBoost = trendSignals.lightweight ? 8 : trendSignals.highReturnRisk ? -18 : 0
  const trendMultiplier = getSourcingTrendMultiplier({
    title: product.title,
    sourceNiche: product.sourceNiche,
    price: product.amazonPrice,
    imageCount,
  })
  const total =
    (profitScore + roiScore + marginScore + demandScore + priceSweetSpot + imageBoost + logisticsBoost) *
    riskPenalty *
    reviewTrust *
    trendMultiplier
  return Number.isFinite(total) ? Number(total.toFixed(2)) : 0
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

  product.qualityScore = scoreProduct(product)
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
    available: row.cached_available === null ? undefined : row.cached_available,
    _rating: parseNumber(row.rating),
    _numRatings: Math.round(parseNumber(row.review_count)),
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
        profit, roi, image_url, risk, sales_volume, rating, review_count, total_score, raw
      )
      SELECT
        asin, title, source_niche, source_provider, source_query, amazon_price, ebay_price,
        profit, roi, image_url, risk, sales_volume, rating, review_count, total_score, raw
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
        raw = product_source_items.raw || EXCLUDED.raw,
        active = TRUE,
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
  const products: SourceProductInput[] = []
  for (const row of rows) {
    const rowProducts = Array.isArray(row.results) ? row.results : []
    for (const product of rowProducts) {
      products.push({
        ...product,
        sourceNiche: product.sourceNiche || row.niche,
        sourceProvider: 'cache',
      })
    }
  }
  return upsertProductSourceItems(products)
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

        // Direct Amazon scraper is the default. External API fallback is opt-in only.
        if (!freshPrice) {
          try {
            const scraped = await scrapeAmazonProduct(row.asin)
            if (scraped) {
              if (!scraped.available || scraped.price <= 0) {
                await sql`UPDATE product_source_items SET active = FALSE, last_seen_at = NOW() WHERE asin = ${row.asin}`.catch(() => {})
                failed += 1
                return
              }
              freshPrice = scraped.price
            }
          } catch { /* scraper also failed — skip */ }
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

export async function loadProductSourceProducts(options: { niche?: string | null; limit?: number } = {}) {
  await ensureProductSourceTables()
  const limit = Math.max(1, Math.min(900, options.limit || 120))
  const rowLimit = Math.min(2500, Math.max(limit, limit * 3))
  try {
    const niche = options.niche?.trim()
    const rows = niche
      ? await queryRows<ProductSourceRow>`
          SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price, psi.profit, psi.roi, psi.image_url, psi.risk,
                 psi.sales_volume, psi.rating, psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
                 apc.title AS cached_title, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                 apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                 apc.available AS cached_available
          FROM product_source_items psi
          LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
          WHERE psi.active = TRUE
            AND psi.source_niche = ${niche}
            AND psi.last_seen_at > NOW() - INTERVAL '21 days'
            AND psi.profit >= 3
            AND psi.roi >= 25
            AND psi.risk <> 'HIGH'
            AND psi.image_url IS NOT NULL
            AND psi.image_url <> ''
            AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
            AND COALESCE(apc.available, TRUE) <> FALSE
          ORDER BY psi.intelligence_score DESC NULLS LAST, psi.total_score DESC, psi.last_seen_at DESC
          LIMIT ${rowLimit}
        `
      : await queryRows<ProductSourceRow>`
          SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price, psi.ebay_price, psi.profit, psi.roi, psi.image_url, psi.risk,
                 psi.sales_volume, psi.rating, psi.review_count, psi.total_score, psi.intelligence_score, psi.source_quality, psi.raw,
                 apc.title AS cached_title, apc.primary_image AS cached_primary_image, apc.images AS cached_images,
                 apc.features AS cached_features, apc.description AS cached_description, apc.specs AS cached_specs,
                 apc.available AS cached_available
          FROM product_source_items psi
          LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
          WHERE psi.active = TRUE
            AND psi.last_seen_at > NOW() - INTERVAL '21 days'
            AND psi.profit >= 3
            AND psi.roi >= 25
            AND psi.risk <> 'HIGH'
            AND psi.image_url IS NOT NULL
            AND psi.image_url <> ''
            AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
            AND COALESCE(apc.available, TRUE) <> FALSE
          ORDER BY psi.intelligence_score DESC NULLS LAST, psi.total_score DESC, psi.last_seen_at DESC
          LIMIT ${rowLimit}
        `
    return rows
      .map(rowToProduct)
      .filter((product) => !isWeakListingTitle(product.title))
      .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))
      .slice(0, limit)
  } catch {
    return []
  }
}
