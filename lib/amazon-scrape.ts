// Direct Amazon page scraper — StackPilot's primary product source.
// Fetches product data straight from amazon.com with no API key required

import { chooseBestListingTitle, isWeakListingTitle } from '@/lib/listing-quality'
import { evaluateAmazonFulfillmentText } from '@/lib/amazon-fulfillment'
import { extractAmazonAvailabilityScope, extractAmazonBuyBoxPrice, extractAmazonPurchaseScope } from '@/lib/amazon-price-parser'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
}

export interface AmazonProduct {
  asin: string
  title: string
  price: number
  images: string[]
  features: string[]
  description: string
  specs: Array<[string, string]>
  available: boolean
  // TRUE only when Amazon's page EXPLICITLY says the item is unavailable ("currently
  // unavailable", etc.). Distinguishes a real out-of-stock from a blocked/unreadable
  // scrape (which leaves `available` false but this false) so callers never treat a
  // bot-blocked read as out-of-stock.
  outOfStockConfirmed: boolean
  bestSellerRank?: number
  primeEligible?: boolean | null
  deliveryDaysMax?: number | null
  fastFulfillment?: boolean
  fulfillmentSummary?: string
}

function extractBetween(html: string, open: string, close: string): string {
  const start = html.indexOf(open)
  if (start === -1) return ''
  const end = html.indexOf(close, start + open.length)
  if (end === -1) return ''
  return html.slice(start + open.length, end).trim()
}

function stripTags(s: string): string {
  return s.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
}

function decodeHtmlAttribute(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

function extractSearchTitle(block: string): string {
  const candidates: string[] = []
  const h2Blocks = block.match(/<h2\b[\s\S]*?<\/h2>/gi) || []

  for (const h2 of h2Blocks) {
    const aria = h2.match(/\baria-label="([^"]{8,700})"/i)?.[1]
    if (aria) candidates.push(decodeHtmlAttribute(aria))
    candidates.push(stripTags(decodeHtmlEntities(h2)))
  }

  const linkTitle = block.match(/<a\b[^>]*class="[^"]*\ba-text-normal\b[^"]*"[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1]
  if (linkTitle) candidates.push(stripTags(decodeHtmlEntities(linkTitle)))

  const legacyTitle =
    block.match(/class="a-size-medium[^"]*a-color-base[^"]*a-text-normal"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ||
    block.match(/class="a-size-base-plus[^"]*\ba-text-normal\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]
  if (legacyTitle) candidates.push(stripTags(decodeHtmlEntities(legacyTitle)))

  return chooseBestListingTitle(candidates)
}

function upgradeAmazonImageUrl(url: string): string {
  return decodeHtmlEntities(url)
    .replace(/\\/g, '')
    .replace(/\._[^.]+(?=\.(jpg|jpeg|png|webp))/gi, '')
    .replace(/\.(jpg|jpeg|png|webp)\?.*$/i, '.$1')
}

function dedupeImages(values: string[]) {
  return Array.from(new Set(values.filter((url) => url.startsWith('http')).map((url) => upgradeAmazonImageUrl(url))))
}

function extractGalleryScopes(html: string): string[] {
  const scopes: string[] = []
  const anchors = [
    'id="landingImage"',
    'id="imgTagWrapperId"',
    'id="main-image-container"',
    'id="altImages"',
    '"ImageBlockATF"',
    '"imageBlockVariations_feature_div"',
  ]

  for (const anchor of anchors) {
    const idx = html.indexOf(anchor)
    if (idx === -1) continue
    const start = Math.max(0, idx - 2500)
    const end = Math.min(html.length, idx + 65000)
    scopes.push(html.slice(start, end))
  }

  return scopes.length > 0 ? scopes : [html]
}

function extractDynamicImageUrls(html: string): string[] {
  const urls: string[] = []

  for (const scope of extractGalleryScopes(html)) {
    for (const dynamicImageMatch of scope.matchAll(/data-a-dynamic-image="([^"]+)"/g)) {
      if (urls.length >= 12) break
      if (!dynamicImageMatch?.[1]) continue
      const decoded = decodeHtmlEntities(dynamicImageMatch[1])
      for (const match of decoded.matchAll(/https:[^"]+\.(?:jpg|jpeg|png|webp)/gi)) {
        if (urls.length >= 12) break
        const url = upgradeAmazonImageUrl(match[0])
        if (url.startsWith('http') && !urls.includes(url)) urls.push(url)
      }
    }

    for (const pattern of [
      /"hiRes"\s*:\s*"(https:[^"]+)"/g,
      /"large"\s*:\s*"(https:[^"]+)"/g,
      /data-old-hires="(https:[^"]+)"/g,
    ]) {
      for (const match of scope.matchAll(pattern)) {
        if (urls.length >= 12) break
        const url = upgradeAmazonImageUrl(match[1])
        if (url.startsWith('http') && !urls.includes(url)) urls.push(url)
      }
    }
    if (urls.length >= 12) break
  }

  return urls
}

function extractVisibleTextBlocks(html: string): string[] {
  const blocks: string[] = []
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')

  for (const match of cleaned.matchAll(/<(p|li|h[1-6]|span|div)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(decodeHtmlEntities(match[2] || ''))
    if (!text) continue
    if (text.length < 30 || text.length > 380) continue
    if (/[{};]/.test(text) && /(padding|width|height|background|position|display|module|a plus|a-plus|widget)/i.test(text)) continue
    if (/data-csa|aplus|module|desktop|wrapper|padding|margin|background-image|function/i.test(text)) continue
    blocks.push(text)
    if (blocks.length >= 12) break
  }

  return Array.from(new Set(blocks))
}

export async function scrapeAmazonProduct(asin: string): Promise<AmazonProduct | null> {
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}?th=1&psc=1`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return null

    const html = await res.text()
    if (html.includes('api-services-support@amazon.com') || html.length < 50000) return null

    let title = ''
    const titlePatterns = [
      /id="productTitle"[^>]*>\s*([^<]{5,200})/,
      /id="title"[^>]*>\s*<span[^>]*>\s*([^<]{5,200})/,
    ]
    for (const pattern of titlePatterns) {
      const match = html.match(pattern)
      if (match) {
        title = match[1].trim()
        break
      }
    }
    if (!title) return null

    const price = extractAmazonBuyBoxPrice(html)

    let images = dedupeImages([
      ...extractDynamicImageUrls(html),
    ]).slice(0, 12)

    if (images.length === 0) {
      const mainImg =
        html.match(/id="landingImage"[^>]*data-a-dynamic-image="([^"]+)"/) ||
        html.match(/id="imgBlkFront"[^>]*src="(https:[^"]+)"/)
      if (mainImg) images = [upgradeAmazonImageUrl(mainImg[1].split('"')[0])]
    }

    const features: string[] = []
    const bulletSection = extractBetween(html, 'id="feature-bullets"', '</ul>')
    if (bulletSection) {
      const items = bulletSection.match(/<span[^>]*class="a-list-item"[^>]*>([\s\S]*?)<\/span>/g) || []
      for (const item of items) {
        const text = stripTags(item)
        if (text && text.length > 10 && text.length < 300 && !text.toLowerCase().includes('make sure')) {
          features.push(text)
          if (features.length >= 8) break
        }
      }
    }

    const specs: Array<[string, string]> = []
    const specSection =
      extractBetween(html, 'id="productDetails_techSpec_section_1"', '</table>') ||
      extractBetween(html, 'id="productDetails_db_sections"', '</table>')
    if (specSection) {
      const rows = specSection.match(/<tr[\s\S]*?<\/tr>/g) || []
      for (const row of rows) {
        const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) || []
        if (cells.length >= 2) {
          const key = stripTags(cells[0] ?? '')
          const val = stripTags(cells[1] ?? '')
          if (key && val && key.length < 60 && val.length < 200) {
            specs.push([key, val])
            if (specs.length >= 12) break
          }
        }
      }
    }

    const descriptionSources = [
      extractBetween(html, 'id="productDescription"', '</div>'),
      extractBetween(html, 'id="bookDescription_feature_div"', '</div>'),
      extractBetween(html, 'id="aplus_feature_div"', '</div>'),
      extractBetween(html, '"productDescription":"', '","'),
    ]
    const richBlocks = descriptionSources.flatMap((source) => extractVisibleTextBlocks(source))
    const description = richBlocks.length > 0
      ? richBlocks.slice(0, 6).join(' ')
      : descriptionSources
        .map((source) => stripTags(decodeHtmlEntities(source)))
        .find((source) => source.length > 60 && !/(data-csa|aplus|module|desktop|wrapper|padding|margin|background-image|function)/i.test(source)) || ''

    let bestSellerRank: number | undefined
    const bsrJsonMatch = html.match(/"bestsellerRank"\s*:\s*\[?\s*\{[^}]*?"rank"\s*:\s*(\d+)/i)
    if (bsrJsonMatch) {
      bestSellerRank = parseInt(bsrJsonMatch[1], 10) || undefined
    }
    if (!bestSellerRank) {
      const bsrHtmlMatch =
        html.match(/Best\s+Sellers\s+Rank[^#]*#([\d,]+)/i) ||
        html.match(/<li[^>]*id="SalesRank"[^>]*>[\s\S]*?#([\d,]+)/i) ||
        html.match(/"salesRank"\s*:\s*(\d+)/i)
      if (bsrHtmlMatch) {
        bestSellerRank = parseInt(bsrHtmlMatch[1].replace(/,/g, ''), 10) || undefined
      }
    }
    if (bestSellerRank && (bestSellerRank < 1 || bestSellerRank > 5_000_000)) bestSellerRank = undefined

    // Stock/Prime phrases in carousels and related-product widgets do not describe
    // this ASIN. Restrict all purchase-state signals to the product buy box.
    const purchaseScope = extractAmazonPurchaseScope(html)
    const availabilityText = extractAmazonAvailabilityScope(html).toLowerCase()
    const hasUnavailableSignal =
      availabilityText.includes('currently unavailable') ||
      availabilityText.includes('no featured offers available') ||
      availabilityText.includes("we don't know when or if this item will be back in stock") ||
      availabilityText.includes('temporarily out of stock') ||
      availabilityText.includes('not currently available')
    const hasBuyBox =
      /id="add-to-cart-button"|name="submit\.add-to-cart"|id="buy-now-button"|name="submit\.buy-now"/i.test(purchaseScope)
    const fulfillment = evaluateAmazonFulfillmentText(purchaseScope)
    const available = !hasUnavailableSignal && !fulfillment.blockedOrSlow && hasBuyBox && price > 0

    return {
      asin,
      title: stripTags(title),
      price,
      images,
      features,
      description,
      specs,
      available,
      outOfStockConfirmed: hasUnavailableSignal,
      bestSellerRank,
      primeEligible: fulfillment.primeEligible,
      deliveryDaysMax: fulfillment.deliveryDaysMax,
      fastFulfillment: fulfillment.fastFulfillment,
      fulfillmentSummary: fulfillment.summary,
    }
  } catch {
    return null
  }
}

// Search Amazon for products in a niche — scrapes search results page
export async function scrapeAmazonSearch(
  query: string,
  page = 1,
  timeoutMs = 12000
): Promise<Array<{ asin: string; title: string; price: number; imageUrl: string; rating: number; reviewCount: number }>> {
  try {
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&page=${page}`
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return []

    const html = await res.text()
    if (html.includes('api-services-support@amazon.com') || html.length < 30000) return []

    const results: Array<{ asin: string; title: string; price: number; imageUrl: string; rating: number; reviewCount: number }> = []
    const productBlocks =
      html.match(/data-asin="([A-Z0-9]{10})"[\s\S]*?data-component-type="s-search-result"[\s\S]*?(?=data-asin="|$)/g) ||
      []

    for (const block of productBlocks) {
      if (results.length >= 20) break
      const asinMatch = block.match(/data-asin="([A-Z0-9]{10})"/)
      if (!asinMatch) continue
      const foundAsin = asinMatch[1]

      const title = extractSearchTitle(block)
      if (!title || title.length < 5 || isWeakListingTitle(title)) continue

      // Skip sponsored ("Ad") results — Amazon prefixes these "Ad - ..." and their
      // ASIN↔title pairing is unreliable, which produces wrong-product listings that
      // fail at eBay with ASIN_MISMATCH. Drop them at the source.
      if (/^ad\s*[-–:]\s+/i.test(title) || block.includes('AdHolder') || block.includes('s-sponsored-label')) continue

      const priceMatch = block.match(/"a-price-whole"[^>]*>(\d[\d,]*)</)
      const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0

      const imgMatch = block.match(/class="s-image"[^>]*src="(https:[^"]+)"/)
      const imageUrl = imgMatch ? imgMatch[1] : ''

      const ratingMatch = block.match(/aria-label="([\d.]+) out of 5 stars"/)
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0

      const reviewMatch = block.match(/aria-label="([\d,]+) ratings"/)
      const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : 0

      results.push({ asin: foundAsin, title, price, imageUrl, rating, reviewCount })
    }

    return results
  } catch {
    return []
  }
}
