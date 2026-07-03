import { queryRows, sql } from '@/lib/db'
import { scrapeAmazonProduct, scrapeAmazonSearch } from '@/lib/amazon-scrape'
import { getRapidApiKey } from '@/lib/rapidapi'
import { evaluateAmazonFulfillmentText } from '@/lib/amazon-fulfillment'

type FetchAmazonProductOptions = {
  asin: string
  fallbackImage?: string
  fallbackTitle?: string
  fallbackPrice?: number
  strictAsin?: boolean
}

export type ValidatedAmazonProduct = {
  asin: string
  title: string
  amazonPrice: number
  images: string[]
  imageUrl?: string
  features: string[]
  description: string
  specs: Array<[string, string]>
  brand?: string
  available: boolean
  primeEligible?: boolean | null
  deliveryDaysMax?: number | null
  fastFulfillment?: boolean | null
  fulfillmentSummary?: string | null
  bestSellerRank?: number
  source: 'api' | 'search' | 'scrape' | 'cache' | 'fallback'
  usedFallbackTitle?: boolean
  usedFallbackPrice?: boolean
}

type CachedAmazonProduct = {
  asin: string
  title: string
  amazon_price: string | number
  images: unknown
  primary_image: string | null
  features: unknown
  description: string | null
  specs: unknown
  brand: string | null
  available: boolean | null
  prime_eligible?: boolean | null
  delivery_days_max?: number | null
  fast_fulfillment?: boolean | null
  fulfillment_summary?: string | null
  best_seller_rank: number | null
}

function normalizeImageUrl(value: unknown) {
  const url = String(value || '').trim()
  return url.startsWith('http') ? url : ''
}

function parseAmazonPrice(value: unknown) {
  if (typeof value === 'number') return value
  const parsed = parseFloat(String(value || '').replace(/[^0-9.]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function sanitizeTitle(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeTitle(value: string) {
  return sanitizeText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(pack|set|piece|pcs|count|for|with|and|the|a|an|of|to|in)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getTitleScore(sourceTitle: string, candidateTitle: string) {
  const sourceWords = new Set(normalizeTitle(sourceTitle).split(' ').filter(Boolean))
  const candidateWords = new Set(normalizeTitle(candidateTitle).split(' ').filter(Boolean))
  if (sourceWords.size === 0 || candidateWords.size === 0) return 0

  let overlap = 0
  for (const word of sourceWords) {
    if (candidateWords.has(word)) overlap += 1
  }

  return overlap / Math.max(sourceWords.size, candidateWords.size)
}

function dedupeImages(values: string[]) {
  return Array.from(new Set(values.filter((url) => url.startsWith('http'))))
}

function chooseResolvedAmazonPrice(products: ValidatedAmazonProduct[], fallbackPrice?: number) {
  const positivePrices = products
    .map((product) => ({
      source: product.source,
      price: Number(product.amazonPrice || 0),
    }))
    .filter((entry) => Number.isFinite(entry.price) && entry.price > 0)

  if (positivePrices.length === 0) {
    return Number.isFinite(fallbackPrice) && Number(fallbackPrice) > 0 ? Number(fallbackPrice) : 0
  }

  const liveSources = positivePrices.filter((entry) => ['scrape', 'api', 'search'].includes(entry.source))
  if (liveSources.length > 0) {
    const liveMax = Math.max(...liveSources.map((entry) => entry.price))
    return parseFloat(liveMax.toFixed(2))
  }

  const cached = positivePrices.find((entry) => entry.source === 'cache')
  if (cached) {
    return parseFloat(cached.price.toFixed(2))
  }

  const fallbackResolved = Math.max(...positivePrices.map((entry) => entry.price))
  return parseFloat(fallbackResolved.toFixed(2))
}

function hasRichContent(product: Pick<ValidatedAmazonProduct, 'images' | 'features' | 'description'> | null | undefined) {
  if (!product) return false
  return product.images.length >= 2 || product.features.length >= 3 || product.description.length >= 120
}

function normalizeFeatures(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .map((entry) => sanitizeText(entry))
        .filter((entry) => entry.length > 6)
        .slice(0, 12)
    )
  )
}

function normalizeSpecs(value: unknown) {
  if (!Array.isArray(value)) return []
  const specs: Array<[string, string]> = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const key = sanitizeText(entry[0]).slice(0, 120)
    const val = sanitizeText(entry[1]).slice(0, 300)
    if (!key || !val) continue
    specs.push([key, val])
    if (specs.length >= 20) break
  }
  return specs
}

function inferBrand(title: string, specs: Array<[string, string]>, brand?: string) {
  const direct = sanitizeText(brand)
  if (direct) return direct
  const specBrand = specs.find(([key]) => /brand/i.test(key))
  if (specBrand?.[1]) return sanitizeText(specBrand[1])
  const firstWord = sanitizeTitle(title).split(/\s+/)[0] || ''
  return firstWord.length > 1 ? firstWord : ''
}

function toSpecEntries(value: unknown) {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>)
    .map(([key, val]) => [sanitizeText(key), sanitizeText(val)] as [string, string])
    .filter(([key, val]) => key.length > 1 && val.length > 1)
    .slice(0, 16)
}

function flattenFulfillmentText(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = sanitizeText(value)
    return /(prime|delivery|arrives?|ships?|stock|available|fulfill)/i.test(text) ? [text] : []
  }
  if (typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)

  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenFulfillmentText(entry, seen)).slice(0, 80)
  }

  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, entry]) => {
      const keyText = /(prime|delivery|arrives?|ships?|stock|available|fulfill)/i.test(key) ? [key] : []
      return [...keyText, ...flattenFulfillmentText(entry, seen)]
    })
    .slice(0, 80)
}

function mergeProducts(asin: string, products: Array<ValidatedAmazonProduct | null>, options: FetchAmazonProductOptions) {
  const validProducts = products.filter((product): product is ValidatedAmazonProduct => Boolean(product))
  if (validProducts.length === 0) return null

  const preferred =
    validProducts.find((product) => product.source === 'scrape') ||
    validProducts.find((product) => product.source === 'api') ||
    validProducts.find((product) => product.source === 'search') ||
    validProducts[0]

  const alignedProducts = validProducts.filter((product) => {
    if (product.source === preferred.source) return true
    return getTitleScore(preferred.title, product.title) >= 0.72
  })

  const trustedProducts = alignedProducts.length > 0 ? alignedProducts : [preferred]
  const trustedImages = dedupeImages(trustedProducts.flatMap((product) => product.images))
  const images = trustedImages.length > 0
    ? trustedImages
    : dedupeImages([normalizeImageUrl(options.fallbackImage)])
  const resolvedPrice = chooseResolvedAmazonPrice(trustedProducts, options.fallbackPrice)
  const richestProduct =
    trustedProducts.find((product) => hasRichContent(product)) ||
    preferred
  const scrapedProduct = trustedProducts.find((product) => product.source === 'scrape')
  const liveProducts = trustedProducts.filter((product) => ['scrape', 'api', 'search'].includes(product.source))
  const available = scrapedProduct
    ? scrapedProduct.available
    : liveProducts.length > 0
      ? liveProducts.some((product) => product.available)
      : trustedProducts.some((product) => product.available)

  return toProduct({
    asin,
    title: preferred.title,
    amazonPrice: resolvedPrice,
    images,
    features: richestProduct.features,
    description: richestProduct.description || preferred.description,
    specs: richestProduct.specs,
    brand: richestProduct.brand || preferred.brand,
    available,
    primeEligible: scrapedProduct?.primeEligible ?? preferred.primeEligible ?? null,
    deliveryDaysMax: scrapedProduct?.deliveryDaysMax ?? preferred.deliveryDaysMax ?? null,
    fastFulfillment: scrapedProduct?.fastFulfillment ?? preferred.fastFulfillment ?? null,
    fulfillmentSummary: scrapedProduct?.fulfillmentSummary ?? preferred.fulfillmentSummary ?? null,
    source: preferred.source,
    fallbackTitle: options.fallbackTitle,
    fallbackPrice: options.fallbackPrice,
  })
}

function normalizeCachedImages(value: unknown) {
  if (!Array.isArray(value)) return []
  return dedupeImages(value.map((entry) => normalizeImageUrl(entry)))
}

function toProduct(input: {
  asin: string
  title?: string
  amazonPrice?: number
  images?: string[]
  features?: unknown
  description?: unknown
  specs?: unknown
  brand?: string
  available?: boolean
  primeEligible?: boolean | null
  deliveryDaysMax?: number | null
  fastFulfillment?: boolean | null
  fulfillmentSummary?: string | null
  bestSellerRank?: number
  source: ValidatedAmazonProduct['source']
  fallbackTitle?: string
  fallbackPrice?: number
}): ValidatedAmazonProduct | null {
  const title = sanitizeTitle(input.title || input.fallbackTitle)
  const images = dedupeImages(input.images || [])
  const features = normalizeFeatures(input.features)
  const description = sanitizeText(input.description)
  const specs = normalizeSpecs(input.specs)
  const recoveredPrice = Number.isFinite(input.amazonPrice) ? Number(input.amazonPrice) : 0
  const fallbackPrice = Number.isFinite(input.fallbackPrice) ? Number(input.fallbackPrice) : 0
  const amazonPrice = recoveredPrice > 0 ? recoveredPrice : fallbackPrice

  if (!title || amazonPrice <= 0) return null

  return {
    asin: input.asin,
    title,
    amazonPrice,
    images,
    imageUrl: images[0],
    features,
    description,
    specs,
    brand: inferBrand(title, specs, input.brand),
    available: input.available ?? amazonPrice > 0,
    primeEligible: input.primeEligible ?? null,
    deliveryDaysMax: input.deliveryDaysMax ?? null,
    fastFulfillment: input.fastFulfillment ?? null,
    fulfillmentSummary: input.fulfillmentSummary ?? null,
    bestSellerRank: input.bestSellerRank,
    source: input.source,
    usedFallbackTitle: !sanitizeTitle(input.title) && Boolean(input.fallbackTitle),
    usedFallbackPrice: recoveredPrice <= 0 && fallbackPrice > 0,
  }
}

async function ensureAmazonProductCacheTable() {
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
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]'::jsonb`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS description TEXT`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS specs JSONB NOT NULL DEFAULT '[]'::jsonb`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS brand TEXT`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS prime_eligible BOOLEAN`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS delivery_days_max INTEGER`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS fast_fulfillment BOOLEAN`.catch(() => {})
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS fulfillment_summary TEXT`.catch(() => {})
}

export async function loadCachedAmazonProduct(asin: string): Promise<ValidatedAmazonProduct | null> {
  await ensureAmazonProductCacheTable()
  const rows = await queryRows<CachedAmazonProduct>`
    SELECT asin, title, amazon_price, images, primary_image, features, description, specs, brand, available,
           prime_eligible, delivery_days_max, fast_fulfillment, fulfillment_summary, best_seller_rank
    FROM amazon_product_cache
    WHERE asin = ${asin}
    LIMIT 1
  `.catch(() => [])

  const cached = rows[0]
  if (!cached) return null

  const images = dedupeImages([
    normalizeImageUrl(cached.primary_image),
    ...normalizeCachedImages(cached.images),
  ])

  return toProduct({
    asin,
    title: cached.title,
    amazonPrice: parseAmazonPrice(cached.amazon_price),
    images,
    features: cached.features,
    description: cached.description,
    specs: cached.specs,
    brand: sanitizeText(cached.brand),
    available: cached.available ?? true,
    primeEligible: cached.prime_eligible ?? null,
    deliveryDaysMax: cached.delivery_days_max ?? null,
    fastFulfillment: cached.fast_fulfillment ?? null,
    fulfillmentSummary: cached.fulfillment_summary ?? null,
    bestSellerRank: cached.best_seller_rank ?? undefined,
    source: 'cache',
  })
}

export async function saveCachedAmazonProduct(product: ValidatedAmazonProduct) {
  await ensureAmazonProductCacheTable()
  await sql`ALTER TABLE amazon_product_cache ADD COLUMN IF NOT EXISTS best_seller_rank INTEGER`.catch(() => {})
  await sql`
    INSERT INTO amazon_product_cache (asin, title, amazon_price, primary_image, images, features, description, specs, brand, available, prime_eligible, delivery_days_max, fast_fulfillment, fulfillment_summary, best_seller_rank, source, updated_at)
    VALUES (
      ${product.asin},
      ${product.title.slice(0, 500)},
      ${product.amazonPrice.toFixed(2)},
      ${product.imageUrl || null},
      ${JSON.stringify(product.images)},
      ${JSON.stringify(product.features)},
      ${product.description || null},
      ${JSON.stringify(product.specs)},
      ${product.brand || null},
      ${product.available},
      ${product.primeEligible ?? null},
      ${product.deliveryDaysMax ?? null},
      ${product.fastFulfillment ?? null},
      ${product.fulfillmentSummary || null},
      ${product.bestSellerRank ?? null},
      ${product.source},
      NOW()
    )
    ON CONFLICT (asin) DO UPDATE SET
      title = EXCLUDED.title,
      -- Never let a price-less write (e.g. a bot-blocked scrape) downgrade a known
      -- cost to 0.00 — a zero cache price hides the listing from the reprice agent.
      amazon_price = CASE WHEN EXCLUDED.amazon_price > 0 THEN EXCLUDED.amazon_price ELSE amazon_product_cache.amazon_price END,
      primary_image = EXCLUDED.primary_image,
      images = EXCLUDED.images,
      features = EXCLUDED.features,
      description = EXCLUDED.description,
      specs = EXCLUDED.specs,
      brand = EXCLUDED.brand,
      available = EXCLUDED.available,
      prime_eligible = COALESCE(EXCLUDED.prime_eligible, amazon_product_cache.prime_eligible),
      delivery_days_max = COALESCE(EXCLUDED.delivery_days_max, amazon_product_cache.delivery_days_max),
      fast_fulfillment = COALESCE(EXCLUDED.fast_fulfillment, amazon_product_cache.fast_fulfillment),
      fulfillment_summary = COALESCE(EXCLUDED.fulfillment_summary, amazon_product_cache.fulfillment_summary),
      best_seller_rank = COALESCE(EXCLUDED.best_seller_rank, amazon_product_cache.best_seller_rank),
      source = EXCLUDED.source,
      updated_at = NOW()
  `.catch(() => {})
}

export async function fetchProductDetailsFromApi(asin: string, fallbackImage?: string) {
  const rapidKey = getRapidApiKey()
  if (!rapidKey) return null

  const { recordApiCall } = await import('@/lib/quota-tracker')
  const startedAt = Date.now()

  try {
    const url = `https://real-time-amazon-data.p.rapidapi.com/product-details?asin=${asin}&country=US`
    const res = await fetch(url, {
      headers: {
        'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com',
        'x-rapidapi-key': rapidKey,
      },
      signal: AbortSignal.timeout(10000),
    })

    if (res.status === 429 || res.status === 403) {
      recordApiCall({ provider: 'rapidapi', callName: 'product-details', success: false, durationMs: Date.now() - startedAt, errorCode: 'QUOTA_EXCEEDED', errorMessage: `HTTP ${res.status}` }).catch(() => {})
      return null
    }

    const json = await res.json()
    const data = json?.data ?? json
    const quotaMsg = String(data?.message || '').toLowerCase()
    if (quotaMsg.match(/limit|quota|exceed/)) {
      recordApiCall({ provider: 'rapidapi', callName: 'product-details', success: false, durationMs: Date.now() - startedAt, errorCode: 'QUOTA_EXCEEDED', errorMessage: quotaMsg.slice(0, 200) }).catch(() => {})
      return null
    }

    const rawPhotos: unknown[] = Array.isArray(data.product_photos) ? data.product_photos : []
    const realImages = dedupeImages([
      ...rawPhotos.flatMap((photo: unknown) => {
        if (typeof photo === 'string') return [photo]
        if (photo && typeof photo === 'object') {
          const record = photo as Record<string, unknown>
          return [
            normalizeImageUrl(record.url),
            normalizeImageUrl(record.large),
            normalizeImageUrl(record.hiRes),
            normalizeImageUrl(record.main),
            normalizeImageUrl(record.thumb),
          ]
        }
        return []
      }),
      normalizeImageUrl(data.product_photo),
    ])
    // Only use fallbackImage when the API returned no images for this ASIN.
    // Mixing a pool fallbackImage with real API images contaminates the gallery
    // when the pool image belongs to a different product (ASIN cross-mapping).
    const images = realImages.length > 0 ? realImages : dedupeImages([normalizeImageUrl(fallbackImage)])

    const fulfillment = evaluateAmazonFulfillmentText(flattenFulfillmentText(data).join(' | '))
    recordApiCall({ provider: 'rapidapi', callName: 'product-details', success: true, durationMs: Date.now() - startedAt }).catch(() => {})
    return toProduct({
      asin,
      title: data.product_title || data.title,
      amazonPrice: parseAmazonPrice(data.product_price || data.price),
      images,
      features:
        data.about_product ||
        data.feature_bullets ||
        data.bullet_points ||
        data.product_features ||
        data.highlights ||
        [],
      description:
        data.product_description ||
        data.description ||
        data.synopsis ||
        data.product_information ||
        '',
      specs: [
        ...toSpecEntries(data.product_overview),
        ...toSpecEntries(data.product_details),
      ],
      brand: sanitizeText((data as Record<string, unknown>).product_byline || (data as Record<string, unknown>).brand),
      available:
        !fulfillment.blockedOrSlow &&
        String(data.product_availability || '').toLowerCase() !== 'currently unavailable' &&
        parseAmazonPrice(data.product_price || data.price) > 0,
      primeEligible: fulfillment.primeEligible,
      deliveryDaysMax: fulfillment.deliveryDaysMax,
      fastFulfillment: fulfillment.fastFulfillment,
      fulfillmentSummary: fulfillment.summary,
      source: 'api',
    })
  } catch (err) {
    recordApiCall({ provider: 'rapidapi', callName: 'product-details', success: false, durationMs: Date.now() - startedAt, errorCode: 'NETWORK', errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }).catch(() => {})
    return null
  }
}

async function fetchProductFromSearch(asin: string, fallbackImage?: string) {
  const rapidKey = getRapidApiKey()
  if (!rapidKey) return null

  try {
    const url = `https://real-time-amazon-data.p.rapidapi.com/search?query=${asin}&country=US&category_id=aps&page=1`
    const res = await fetch(url, {
      headers: {
        'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com',
        'x-rapidapi-key': rapidKey,
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!res.ok) return null

    const json = await res.json()
    const products: Record<string, unknown>[] = json?.data?.products || []
    const match = products.find((product) => String(product.asin || '').toUpperCase() === asin)
    if (!match) return null

    const matchPhoto = normalizeImageUrl(match.product_photo)
    return toProduct({
      asin,
      title: String(match.product_title || ''),
      amazonPrice: parseAmazonPrice(match.product_price || match.product_original_price),
      images: matchPhoto ? [matchPhoto] : dedupeImages([normalizeImageUrl(fallbackImage)]),
      brand: sanitizeText(match.product_byline || ''),
      available: parseAmazonPrice(match.product_price || match.product_original_price) > 0,
      source: 'search',
    })
  } catch {
    return null
  }
}

// ScraperAPI structured Amazon product endpoint — the RELIABLE paid feed (replaces dead
// RapidAPI). Returns clean price / availability_status / sold_by / ships_from / images.
// Quota-gated: getThrottleState blocks at 90% of the 600-requests/day cap, and every call
// (success or fail) is logged to api_usage_log so a runaway loop can't drain the month.
async function fetchProductFromScraperApi(asin: string, fallbackImage?: string): Promise<ValidatedAmazonProduct | null> {
  const key = String(process.env.SCRAPERAPI_KEY || '').trim()
  if (!key) return null

  const { recordApiCall, getThrottleState } = await import('@/lib/quota-tracker')
  const throttle = await getThrottleState('scraperapi', 'structured-product').catch(() => 'ok' as const)
  if (throttle === 'block') return null

  const startedAt = Date.now()
  try {
    const url = `https://api.scraperapi.com/structured/amazon/product?api_key=${key}&asin=${asin}&country=us`
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) })

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      recordApiCall({ provider: 'scraperapi', callName: 'structured-product', success: false, durationMs: Date.now() - startedAt, errorCode: 'QUOTA_EXCEEDED', errorMessage: `HTTP ${res.status}` }).catch(() => {})
      return null
    }
    if (!res.ok) {
      recordApiCall({ provider: 'scraperapi', callName: 'structured-product', success: false, durationMs: Date.now() - startedAt, errorCode: `HTTP_${res.status}` }).catch(() => {})
      return null
    }

    const data = (await res.json()) as Record<string, unknown>
    const availability = sanitizeText(data.availability_status)
    const soldBy = sanitizeText(data.sold_by)
    const shipsFrom = sanitizeText(data.ships_from)
    const price = parseAmazonPrice(data.pricing)
    // Only an EXPLICIT "unavailable" reading counts as OOS. Missing/ambiguous availability
    // must NEVER read as out-of-stock (that bug once deleted 14 good listings).
    const explicitOOS = /unavailable|out of stock|temporarily out/i.test(availability)
    const haveSeller = Boolean(soldBy || shipsFrom)
    const amazonFulfilled = /amazon/i.test(soldBy) || /amazon/i.test(shipsFrom)
    const images = dedupeImages([
      ...(Array.isArray(data.images) ? (data.images as unknown[]).map((entry) => normalizeImageUrl(entry)) : []),
      normalizeImageUrl((data as Record<string, unknown>).main_image),
    ])

    recordApiCall({ provider: 'scraperapi', callName: 'structured-product', success: true, durationMs: Date.now() - startedAt }).catch(() => {})
    return toProduct({
      asin,
      title: sanitizeTitle(data.name || data.title),
      amazonPrice: price,
      images: images.length > 0 ? images : dedupeImages([normalizeImageUrl(fallbackImage)]),
      features: data.feature_bullets || [],
      description: sanitizeText(data.full_description || data.small_description || ''),
      specs: toSpecEntries(data.product_information),
      brand: sanitizeText(data.brand),
      available: !explicitOOS && price > 0,
      primeEligible: haveSeller ? amazonFulfilled : null,
      deliveryDaysMax: null,
      fastFulfillment: haveSeller ? amazonFulfilled : null,
      fulfillmentSummary:
        [availability, soldBy ? `Sold by ${soldBy}` : '', shipsFrom ? `Ships from ${shipsFrom}` : '']
          .filter(Boolean)
          .join(' | ') || null,
      source: 'api',
    })
  } catch (err) {
    recordApiCall({ provider: 'scraperapi', callName: 'structured-product', success: false, durationMs: Date.now() - startedAt, errorCode: 'NETWORK', errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }).catch(() => {})
    return null
  }
}

async function fetchProductFromScrape(asin: string, fallbackImage?: string) {
  const scraped = await scrapeAmazonProduct(asin).catch(() => null)
  if (!scraped) return null

  return toProduct({
    asin,
    title: scraped.title,
    amazonPrice: scraped.price,
    images: scraped.images.length > 0 ? scraped.images : dedupeImages([normalizeImageUrl(fallbackImage)]),
    features: scraped.features,
    description: scraped.description,
    specs: scraped.specs,
    available: scraped.available && scraped.price > 0,
    primeEligible: scraped.primeEligible,
    deliveryDaysMax: scraped.deliveryDaysMax,
    fastFulfillment: scraped.fastFulfillment,
    fulfillmentSummary: scraped.fulfillmentSummary,
    bestSellerRank: scraped.bestSellerRank,
    source: 'scrape',
  })
}

async function fetchSearchFallbackByTitle(title: string, fallbackImage?: string, fallbackPrice?: number) {
  const query = sanitizeTitle(title)
  if (!query) return null

  const scraped = await scrapeAmazonSearch(query).catch(() => [])
  const top = scraped[0]
  if (!top?.asin) return null

  const byAsin = await fetchProductFromSearch(top.asin, top.imageUrl || fallbackImage)
  if (byAsin) return byAsin

  return toProduct({
    asin: top.asin,
    title: top.title,
    amazonPrice: top.price,
    images: [top.imageUrl, normalizeImageUrl(fallbackImage)],
    available: top.price > 0,
    source: 'search',
    fallbackPrice,
  })
}

// Pre-enriches products in product_source_items that are missing from amazon_product_cache.
// Runs during the daily cron to ensure continuous-listing products have rich data
// (images, features, description) before users try to list them in bulk.
export async function warmAmazonProductCache(
  limit = 40,
  options: { niches?: string[] } = {}
): Promise<{ warmed: number; failed: number; enrichedWithImages: number }> {
  await ensureAmazonProductCacheTable()
  // Enrich the BEST products first. Sort by master_score (composite signal: profit, ROI,
  // demand, reviews, rating, BSR, eBay competition, listing outcome) with total_score as
  // tiebreaker. Apply explicit quality floors so RapidAPI calls only target products that
  // would actually be list-worthy after enrichment — never spend a call on something that
  // would still be excluded for being too risky / unprofitable / rejected.
  //
  // Optional `niches` filter restricts the queue to specific source_niche values — used
  // when we've identified HOT niches via eBay market audit and want to spend RapidAPI
  // quota only on proven-strong categories.
  const allowedNiches = (options.niches || []).filter((n) => typeof n === 'string' && n.length > 0)
  const useNicheFilter = allowedNiches.length > 0
  const rows = useNicheFilter
    ? await queryRows<{ asin: string; image_url: string | null }>`
        SELECT psi.asin, psi.image_url
        FROM product_source_items psi
        LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
        WHERE psi.active = TRUE
          AND apc.asin IS NULL
          AND psi.profit >= 4
          AND psi.roi >= 25
          AND psi.risk <> 'HIGH'
          AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
          AND psi.image_url IS NOT NULL
          AND psi.image_url <> ''
          AND psi.source_niche = ANY(${allowedNiches}::text[])
        ORDER BY psi.master_score DESC NULLS LAST, psi.total_score DESC NULLS LAST, psi.last_seen_at DESC
        LIMIT ${limit}
      `.catch(() => [])
    : await queryRows<{ asin: string; image_url: string | null }>`
        SELECT psi.asin, psi.image_url
        FROM product_source_items psi
        LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
        WHERE psi.active = TRUE
          AND apc.asin IS NULL
          AND psi.profit >= 4
          AND psi.roi >= 25
          AND psi.risk <> 'HIGH'
          AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
          AND psi.image_url IS NOT NULL
          AND psi.image_url <> ''
        ORDER BY psi.master_score DESC NULLS LAST, psi.total_score DESC NULLS LAST, psi.last_seen_at DESC
        LIMIT ${limit}
      `.catch(() => [])

  if (rows.length === 0) return { warmed: 0, failed: 0, enrichedWithImages: 0 }

  let warmed = 0, failed = 0, enrichedWithImages = 0
  const BATCH = 2  // Lowered from 3 — Amazon bot-detects faster with parallel calls
  const INTER_BATCH_DELAY_MS = 750  // Give Amazon a breather between batches

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      batch.map(row =>
        fetchAmazonProductByAsin({
          asin: row.asin,
          fallbackImage: row.image_url || undefined,
          strictAsin: false,
        }).catch(() => null)
      )
    )
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        warmed++
        // Track "real" enrichment vs fallback (we want products with >=2 images for list-ready)
        if (result.value.source !== 'fallback' && (result.value.images?.length || 0) >= 2) {
          enrichedWithImages++
        }
      } else {
        failed++
      }
    }
    // Throttle to reduce Amazon bot detection. Last batch doesn't need to sleep.
    if (i + BATCH < rows.length) {
      await new Promise(resolve => setTimeout(resolve, INTER_BATCH_DELAY_MS))
    }
  }

  return { warmed, failed, enrichedWithImages }
}

export async function fetchAmazonProductByAsin(
  options: FetchAmazonProductOptions
): Promise<ValidatedAmazonProduct | null> {
  const asin = options.asin.toUpperCase().trim()
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null

  const cached = await loadCachedAmazonProduct(asin)

  // Free-scrape FIRST. In production the page scraper succeeds ~99.9% of the time
  // with 2+ images, so leading with it lets us skip the paid RapidAPI calls on
  // almost every product — this is what makes enrichment scale cheaply. The paid
  // API is only used as a fallback when the scrape comes back thin (blocked, no
  // price, unavailable, or <2 images). mergeProducts already prefers scrape data.
  const scrapeResult = await fetchProductFromScrape(asin, options.fallbackImage).catch(() => null)
  const scrapeIsListReady = Boolean(
    scrapeResult &&
    scrapeResult.images.length >= 2 &&
    scrapeResult.amazonPrice > 0 &&
    scrapeResult.available !== false
  )

  // Only spend paid API quota when the free scrape wasn't good enough.
  // ScraperAPI (paid, reliable, quota-capped) is the primary fallback; RapidAPI is dead
  // (returns null without a key) and search is the last resort.
  let scraperApiResult: ValidatedAmazonProduct | null = null
  let apiResult: ValidatedAmazonProduct | null = null
  let searchResult: ValidatedAmazonProduct | null = null
  if (!scrapeIsListReady) {
    const settled = await Promise.allSettled([
      fetchProductFromScraperApi(asin, options.fallbackImage),
      fetchProductDetailsFromApi(asin, options.fallbackImage),
      fetchProductFromSearch(asin, options.fallbackImage),
    ])
    scraperApiResult = settled[0].status === 'fulfilled' ? settled[0].value : null
    apiResult = settled[1].status === 'fulfilled' ? settled[1].value : null
    searchResult = settled[2].status === 'fulfilled' ? settled[2].value : null
  }

  const merged = mergeProducts(asin, [scrapeResult, scraperApiResult, apiResult, searchResult, cached], options)
  if (merged) {
    await saveCachedAmazonProduct(merged)
    return merged
  }

  if (cached && hasRichContent(cached)) {
    return toProduct({
      asin,
      title: cached.title,
      amazonPrice: cached.amazonPrice,
      images: dedupeImages([...cached.images, normalizeImageUrl(options.fallbackImage)]),
      features: cached.features,
      description: cached.description,
      specs: cached.specs,
      brand: cached.brand,
      available: cached.available,
      primeEligible: cached.primeEligible,
      deliveryDaysMax: cached.deliveryDaysMax,
      fastFulfillment: cached.fastFulfillment,
      fulfillmentSummary: cached.fulfillmentSummary,
      source: 'cache',
      fallbackTitle: options.fallbackTitle,
      fallbackPrice: options.fallbackPrice,
    })
  }

  if (!options.strictAsin) {
    const titleFallback = await fetchSearchFallbackByTitle(
      options.fallbackTitle || '',
      options.fallbackImage,
      options.fallbackPrice
    )
    if (titleFallback) {
      await saveCachedAmazonProduct(titleFallback)
      return titleFallback
    }
  }

  return toProduct({
    asin,
    title: options.fallbackTitle || `Item ${asin}`,
    amazonPrice: options.fallbackPrice,
    images: dedupeImages([normalizeImageUrl(options.fallbackImage)]),
    features: [],
    description: '',
    specs: [],
    available: Number(options.fallbackPrice || 0) > 0,
    source: 'fallback',
    fallbackTitle: options.fallbackTitle,
    fallbackPrice: options.fallbackPrice,
  })
}
