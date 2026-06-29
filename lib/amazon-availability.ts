import { scrapeAmazonProduct } from '@/lib/amazon-scrape'
import { saveCachedAmazonProduct, type ValidatedAmazonProduct } from '@/lib/amazon-product'

export type AmazonAvailabilityFailureReason = 'UNAVAILABLE' | 'NO_LIVE_PRICE' | 'CHECK_FAILED'

export type AmazonLiveAvailability =
  | {
      ok: true
      asin: string
      title: string
      amazonPrice: number
      imageUrl?: string
      images: string[]
      checkedAt: string
    }
  | {
      ok: false
      asin: string
      reason: AmazonAvailabilityFailureReason
      title?: string
      amazonPrice?: number
      imageUrl?: string
      images?: string[]
      checkedAt: string
    }

type AmazonLiveAvailabilityOptions = {
  fallbackTitle?: string
  fallbackImage?: string
}

function normalizeAsin(value: string) {
  return String(value || '').trim().toUpperCase()
}

async function cacheLiveAvailability(args: {
  asin: string
  title: string
  amazonPrice: number
  images: string[]
  available: boolean
  primeEligible?: boolean | null
  deliveryDaysMax?: number | null
  fastFulfillment?: boolean | null
  fulfillmentSummary?: string | null
}) {
  const images = Array.from(new Set(args.images.filter((url) => url.startsWith('http'))))
  const amazonPrice = Number.isFinite(args.amazonPrice) ? Math.max(0, args.amazonPrice) : 0
  // A scrape with no live price is almost always Amazon bot-detection noise, not
  // real product data. Writing amazon_price = 0.00 here used to overwrite known-good
  // cached costs (0.00 is not NULL, so it silently hid ~2,170 live listings from the
  // reprice agent's COALESCE filter). Skip the cache write entirely instead.
  if (amazonPrice <= 0) return
  const product: ValidatedAmazonProduct = {
    asin: args.asin,
    title: args.title || `Item ${args.asin}`,
    amazonPrice,
    imageUrl: images[0],
    images,
    features: [],
    description: '',
    specs: [],
    available: args.available,
    primeEligible: args.primeEligible ?? null,
    deliveryDaysMax: args.deliveryDaysMax ?? null,
    fastFulfillment: args.fastFulfillment ?? null,
    fulfillmentSummary: args.fulfillmentSummary ?? null,
    source: 'scrape',
  }
  await saveCachedAmazonProduct(product).catch(() => {})
}

export async function checkAmazonLiveAvailability(
  asinInput: string,
  options: AmazonLiveAvailabilityOptions = {}
): Promise<AmazonLiveAvailability> {
  const asin = normalizeAsin(asinInput)
  const checkedAt = new Date().toISOString()
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    return { ok: false, asin, reason: 'CHECK_FAILED', checkedAt }
  }

  const scraped = await scrapeAmazonProduct(asin).catch(() => null)
  if (!scraped) {
    return { ok: false, asin, reason: 'CHECK_FAILED', checkedAt }
  }

  const title = scraped.title || options.fallbackTitle || `Item ${asin}`
  const images = Array.from(
    new Set([
      ...scraped.images,
      options.fallbackImage || '',
    ].filter((url) => url.startsWith('http')))
  )
  const amazonPrice = Number.isFinite(scraped.price) ? Number(scraped.price) : 0
  const isAvailable = Boolean(scraped.available && amazonPrice > 0)

  await cacheLiveAvailability({
    asin,
    title,
    // Pass the real scraped price even when unavailable — cacheLiveAvailability
    // skips the write when there is no price, so 0 never reaches the cache.
    amazonPrice,
    images,
    available: isAvailable,
    primeEligible: scraped.primeEligible,
    deliveryDaysMax: scraped.deliveryDaysMax,
    fastFulfillment: scraped.fastFulfillment,
    fulfillmentSummary: scraped.fulfillmentSummary,
  })

  if (!scraped.available) {
    // Only report UNAVAILABLE when Amazon EXPLICITLY confirmed it ("currently unavailable",
    // etc.). A blocked/unreadable scrape (Amazon bot-detection → no buy box, no price, no
    // out-of-stock text) leaves `available` false but `outOfStockConfirmed` false — that means
    // we simply COULDN'T CHECK, not that the item is gone. Returning CHECK_FAILED here (instead
    // of UNAVAILABLE) stops in-stock listings from being falsely flagged out of stock and ended.
    if (!scraped.outOfStockConfirmed) {
      return { ok: false, asin, reason: 'CHECK_FAILED', title, amazonPrice, imageUrl: images[0], images, checkedAt }
    }
    return {
      ok: false,
      asin,
      reason: 'UNAVAILABLE',
      title,
      amazonPrice,
      imageUrl: images[0],
      images,
      checkedAt,
    }
  }

  if (amazonPrice <= 0) {
    return {
      ok: false,
      asin,
      reason: 'NO_LIVE_PRICE',
      title,
      amazonPrice,
      imageUrl: images[0],
      images,
      checkedAt,
    }
  }

  return {
    ok: true,
    asin,
    title,
    amazonPrice,
    imageUrl: images[0],
    images,
    checkedAt,
  }
}
