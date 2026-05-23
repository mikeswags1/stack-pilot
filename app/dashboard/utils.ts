import type { BannerState, BulkListFailure, FinderProduct } from './types'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getRecommendedEbayPrice as getSharedRecommendedEbayPrice } from '@/lib/listing-pricing'
import { isWeakListingTitle } from '@/lib/listing-quality'

export function parseDashboardSearchMessage(search: string): BannerState | null {
  const params = new URLSearchParams(search)
  const ebay = params.get('ebay')
  const amazon = params.get('amazon')
  const msg = params.get('msg')

  if (ebay === 'error') {
    const decoded = msg ? decodeURIComponent(msg) : ''
    const friendly = /fetch failed/i.test(decoded)
      ? 'Unable to reach eBay during connection. Please try again.'
      : decoded
    return { tone: 'error', text: friendly || 'eBay connection failed.' }
  }

  if (ebay === 'connected') {
    return { tone: 'success', text: 'eBay connected successfully.' }
  }

  if (amazon === 'error') {
    return { tone: 'error', text: msg ? `Amazon error: ${decodeURIComponent(msg)}` : 'Amazon connection failed.' }
  }

  if (amazon === 'connected') {
    return { tone: 'success', text: 'Amazon Seller account connected.' }
  }

  return null
}

export function getGrossRevenue(totalOrders: Array<{ pricingSummary?: { total?: { value?: string } } }>) {
  return totalOrders.reduce((sum, order) => sum + parseFloat(order.pricingSummary?.total?.value || '0'), 0)
}

export function getListingPreview(ebayPrice: string, amazonPrice: number, shippingCost: string, feeRate: number) {
  const parsedEbayPrice = parseFloat(ebayPrice) || 0
  const parsedShippingCost = parseFloat(shippingCost) || 0
  const metrics = getListingMetrics(amazonPrice + parsedShippingCost, parsedEbayPrice, feeRate)

  return {
    ebayFee: metrics.fees,
    profit: metrics.profit,
    roi: metrics.roi,
    margin: metrics.margin,
  }
}

export function getRecommendedEbayPrice(amazonPrice: number) {
  return getSharedRecommendedEbayPrice(amazonPrice, EBAY_DEFAULT_FEE_RATE)
}

function countUniqueProductImages(product: FinderProduct) {
  return Array.from(new Set([
    ...(Array.isArray(product.images) ? product.images : []),
    product.imageUrl,
  ].filter((url): url is string => typeof url === 'string' && url.startsWith('http')))).length
}

export function getBulkPreflightIssue(product: FinderProduct): BulkListFailure | null {
  const imageCount = countUniqueProductImages(product)

  // Only block products that are *confirmed* unavailable (available === false).
  // available === undefined means "not yet verified" — allow through so the
  // listing route can do the live check. Blocking undefined was causing almost
  // all pool products to be skipped because many don't have a cache entry yet.
  if (product.available === false) {
    return {
      asin: product.asin,
      title: product.title,
      code: 'PRODUCT_UNAVAILABLE',
      message: 'Skipped before publish: product is confirmed unavailable on Amazon.',
      skipped: true,
    }
  }

  if (isWeakListingTitle(product.title)) {
    return {
      asin: product.asin,
      title: product.title,
      code: 'WEAK_LISTING_TITLE',
      message: 'Skipped before publish: title is too weak or brand-only.',
      skipped: true,
    }
  }

  if (!Number.isFinite(product.amazonPrice) || product.amazonPrice <= 0) {
    return {
      asin: product.asin,
      title: product.title,
      code: 'INVALID_AMAZON_PRICE',
      message: 'Skipped before publish: Amazon cost is missing or invalid.',
      skipped: true,
    }
  }

  if (!Number.isFinite(product.ebayPrice) || product.ebayPrice <= 0) {
    return {
      asin: product.asin,
      title: product.title,
      code: 'INVALID_EBAY_PRICE',
      message: 'Skipped before publish: eBay price is missing or invalid.',
      skipped: true,
    }
  }

  // Require at least 2 images. Sparse candidates should be enriched by the
  // background cache warmer before they become list-ready. If enrichment fails,
  // they stay out of List Ready to maintain quality.
  if (imageCount < 2) {
    return {
      asin: product.asin,
      title: product.title,
      code: 'NEEDS_IMAGE_ENRICHMENT',
      message: imageCount === 0
        ? 'Skipped before publish: no product images available.'
        : 'Skipped before publish: only 1 image found — hit Find Products to enrich.',
      skipped: true,
    }
  }

  if (Number.isFinite(product.profit) && product.profit < 3) {
    return {
      asin: product.asin,
      title: product.title,
      code: 'LOW_PROFIT',
      message: 'Skipped before publish: projected profit is below the safety floor.',
      skipped: true,
    }
  }

  return null
}

function shortTitle(value: string) {
  return value.length > 48 ? `${value.slice(0, 45).trim()}...` : value
}

export function summarizeBulkFailures(failures: BulkListFailure[], maxReasons = 3) {
  if (failures.length === 0) return ''

  const counts = new Map<string, { count: number; message: string }>()
  failures.forEach((failure) => {
    const current = counts.get(failure.code)
    if (current) current.count += 1
    else counts.set(failure.code, { count: 1, message: failure.message })
  })

  return Array.from(counts.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxReasons)
    .map(([, value]) => `${value.count} ${value.count === 1 ? 'item' : 'items'}: ${value.message.replace(/^Skipped before publish:\s*/i, '')}`)
    .join(' ')
}

export function summarizeBulkListResult(result: {
  listedAsins: string[]
  failedAsins: string[]
  skippedAsins: string[]
  failures: BulkListFailure[]
}) {
  const listed = result.listedAsins.length
  const skipped = result.skippedAsins.length
  const failed = result.failedAsins.length
  const parts = [
    `${listed} product${listed === 1 ? '' : 's'} listed`,
  ]
  if (skipped > 0) parts.push(`${skipped} skipped`)
  if (failed > 0) parts.push(`${failed} failed`)
  const reasonSummary = summarizeBulkFailures(result.failures)
  return reasonSummary ? `${parts.join(', ')}. ${reasonSummary}` : `${parts.join(', ')}.`
}

export async function listProductsInBatches(args: {
  products: FinderProduct[]
  publish: (product: FinderProduct) => Promise<{ asin?: string; reconnectRequired?: boolean; errorCode?: string; errorMessage?: string }>
  onProgress: (progress: { done: number; total: number; errors: number; skipped?: number; failures?: BulkListFailure[] }) => void
  concurrency?: number
  preflight?: (product: FinderProduct) => BulkListFailure | null
}) {
  const { products, publish, onProgress, concurrency = 5, preflight } = args
  const total = products.length
  const listedAsins: string[] = []
  const failedAsins: string[] = []
  const skippedAsins: string[] = []
  const failures: BulkListFailure[] = []
  let errors = 0
  let skipped = 0
  let done = 0
  let reconnectRequired = false

  const pushFailure = (product: FinderProduct, failure: Omit<BulkListFailure, 'asin' | 'title'>) => {
    failures.push({
      asin: product.asin,
      title: shortTitle(product.title),
      code: failure.code,
      message: failure.message,
      skipped: failure.skipped,
    })
  }

  const publishWithRetry = async (product: FinderProduct) => {
    const result = await publish(product)
    // One automatic retry for transient network failures (empty result = unknown error)
    if (!result.asin && !result.reconnectRequired && !result.errorCode) {
      await new Promise((resolve) => setTimeout(resolve, 800))
      return publish(product)
    }
    return result
  }

  for (let index = 0; index < total; index += concurrency) {
    if (reconnectRequired) break

    onProgress({ done, total, errors })
    const batch = products.slice(index, index + concurrency)
    const publishableBatch: FinderProduct[] = []

    for (const product of batch) {
      const issue = preflight?.(product) || null
      if (issue) {
        skipped += 1
        errors += 1
        done += 1
        skippedAsins.push(product.asin)
        failures.push(issue)
      } else {
        publishableBatch.push(product)
      }
    }

    if (publishableBatch.length === 0) {
      onProgress({ done, total, errors, skipped, failures: [...failures] })
      continue
    }

    // allSettled: one failure never kills its batchmates
    const settled = await Promise.allSettled(publishableBatch.map((product) => publishWithRetry(product)))

    for (let resultIndex = 0; resultIndex < settled.length; resultIndex += 1) {
      const product = publishableBatch[resultIndex]
      const outcome = settled[resultIndex]
      if (outcome.status === 'rejected') {
        errors += 1
        if (product) {
          failedAsins.push(product.asin)
          pushFailure(product, {
            code: 'LISTING_REQUEST_FAILED',
            message: 'Listing request failed before eBay returned a specific reason.',
          })
        }
        done += 1
        continue
      }
      const result = outcome.value
      if (result.reconnectRequired) {
        reconnectRequired = true
        break
      }
      if (result.asin) {
        listedAsins.push(result.asin)
      } else {
        errors += 1
        if (product) {
          failedAsins.push(product.asin)
          pushFailure(product, {
            code: result.errorCode || 'LISTING_FAILED',
            message: result.errorMessage || 'Listing failed without a specific reason.',
          })
        }
      }
      done += 1
    }

    onProgress({ done, total, errors, skipped, failures: [...failures] })
  }

  onProgress({ done: total, total, errors, skipped, failures: [...failures] })

  return { listedAsins, failedAsins, skippedAsins, failures, errors, skipped, reconnectRequired }
}
