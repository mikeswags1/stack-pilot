import { after, NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows, sql } from '@/lib/db'
import { fetchAmazonProductByAsin } from '@/lib/amazon-product'
import { scrapeAmazonSearch } from '@/lib/amazon-scrape'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getRecommendedEbayPrice, isHealthyListing } from '@/lib/listing-pricing'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { loadProductSourceProducts, upsertProductSourceItems } from '@/lib/product-source-engine'
import { getListingPolicyFlags, hasBlockedListingPolicyFlag } from '@/lib/listing-policy'
import { isWeakListingTitle } from '@/lib/listing-quality'
import { getSeasonalQueryExpansions, getSourcingTrendMultiplier, loadActiveCustomSourceNicheQueries, mergeTrendingNicheQueries } from '@/lib/source-niches'

export const maxDuration = 60

const MAX_COST   = 300
const CACHE_TTL  = 23 * 60 * 60 * 1000 // 23 hours — refresh once per day
const CACHE_VERSION = 6
const TARGET_STOCK = 30
const MAX_POOL_SIZE = 160
const CONTINUOUS_CACHE_KEY = '__continuous_listing__'
const CONTINUOUS_QUERY_LIMIT = 28
const CONTINUOUS_LIVE_FETCH_BUDGET_MS = 4_500
const NICHE_LIVE_FETCH_BUDGET_MS = 16_000
const CONTINUOUS_MIN_FAST_RETURN = 24
const MIN_STOCK_PROFIT = 8
const MIN_STOCK_ROI = 30
const MIN_STOCK_MARGIN = 16
const MIN_PRIMARY_RATING = 3.8
const MIN_ACCEPTABLE_RATING = 3.5
const MIN_PRIMARY_REVIEW_COUNT = 12
const MIN_PRIMARY_SALES = 20

const REJECT_KEYWORDS = [
  'rc plane','rc airplane','drone','laptop','tablet','ipad','iphone','macbook',
  'treadmill','elliptical','mattress','sofa','couch','generator','chainsaw',
  'television',' tv ','monitor','e-bike','pressure washer',
  'louis vuitton','lv bag','gucci','chanel','prada','burberry','versace','fendi',
  'christian dior','yves saint laurent','hermes','hermès','balenciaga','givenchy',
  'rolex','omega watch','patek philippe','audemars piguet','hublot','cartier watch',
  'ray-ban','oakley sunglass','canada goose jacket','moncler jacket',
  'lego set','lego technic','lego duplo',
]

type Product = {
  asin: string; title: string; amazonPrice: number; ebayPrice: number
  profit: number; roi: number; imageUrl?: string; risk: string; salesVolume?: string
  images?: string[]; features?: string[]; description?: string; specs?: Array<[string, string]>
  sourceNiche?: string; sourceQuality?: string; qualityScore?: number
  distributionScore?: number
  available?: boolean
  _rating?: number; _numRatings?: number
}

type QueryEntry = { sourceNiche: string; query: string }
type NicheQueryMap = Record<string, string[]>

type NichePreferenceRow = {
  ebay_listing_id?: string | null
  title?: string | null
  niche?: string | null
  category_name?: string | null
  amazon_price?: string | number | null
  ebay_price?: string | number | null
  ebay_fee_rate?: string | number | null
  ended_at?: string | null
}

type LightweightEbayOrder = {
  orderPaymentStatus?: string
  paymentSummary?: {
    refunds?: Array<{ refundStatus?: string; amount?: { value?: string } }>
  }
  lineItems?: Array<{
    legacyItemId?: string
    quantity?: number
    lineItemCost?: { value?: string }
    refunds?: Array<{ refundStatus?: string; amount?: { value?: string } }>
  }>
}

function normalizeTitle(value: string) {
  return value
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

function canonicalizeImageKey(value?: string) {
  return String(value || '')
    .replace(/\?.*$/, '')
    .replace(/\._[^./]+(?=\.[a-z0-9]+$)/i, '')
    .toLowerCase()
}

function dedupeProducts(products: Product[]) {
  const kept: Product[] = []

  for (const product of products) {
    const productImageKey = canonicalizeImageKey(product.imageUrl)
    const duplicate = kept.find((existing) => {
      const titleScore = getTitleScore(existing.title, product.title)
      const sameImage = productImageKey && productImageKey === canonicalizeImageKey(existing.imageUrl)
      const closePrice = Math.abs(existing.amazonPrice - product.amazonPrice) <= 3
      return sameImage || (titleScore >= 0.72 && closePrice)
    })

    if (!duplicate) {
      kept.push(product)
      continue
    }

    const duplicateScore = getProductScore(duplicate)
    const productScore = getProductScore(product)

    if (productScore > duplicateScore) {
      const index = kept.indexOf(duplicate)
      kept[index] = product
    }
  }

  return kept
}

function calcMetrics(amazonPrice: number) {
  const ebayPrice = getRecommendedEbayPrice(amazonPrice, EBAY_DEFAULT_FEE_RATE)
  const { fees, profit, roi, margin } = getListingMetrics(amazonPrice, ebayPrice, EBAY_DEFAULT_FEE_RATE)
  return { ebayPrice, fees, profit, roi, margin }
}

function repriceProduct(product: Product): Product {
  const amazonPrice = parsePrice(product.amazonPrice)
  if (amazonPrice <= 0) return product
  const { ebayPrice, profit, roi } = calcMetrics(amazonPrice)
  const risk = product.risk === 'HIGH' || amazonPrice > 150
    ? 'HIGH'
    : amazonPrice > 60 || roi < 45 || product.risk === 'MEDIUM'
      ? 'MEDIUM'
      : 'LOW'
  return { ...product, amazonPrice, ebayPrice, profit, roi, risk }
}

function isRejected(title: string) {
  return hasBlockedListingPolicyFlag(getListingPolicyFlags({ title }))
}

function parsePrice(v: unknown): number {
  if (!v) return 0
  if (typeof v === 'number') return v
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''))
  return isNaN(n) ? 0 : n
}

const parseSales = (v?: string) => {
  if (!v) return 1
  const n = parseInt(v.replace(/[^0-9]/g, ''), 10)
  if (isNaN(n)) return 1
  return Math.max(1, Math.min(80_000, n))
}

function hashString(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRatio(seed: string) {
  return hashString(seed) / 0xffffffff
}

function seededShuffle<T>(values: T[], seed: string) {
  return [...values]
    .map((value, index) => ({ value, score: seededRatio(`${seed}:${index}:${JSON.stringify(value)}`) }))
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.value)
}

function getRotationBucket() {
  return Math.floor(Date.now() / (6 * 60 * 60 * 1000))
}

function nicheKey(value?: string | null) {
  return normalizeTitle(String(value || ''))
}

function getNicheWeight(weights: Map<string, number> | undefined, sourceNiche?: string) {
  if (!sourceNiche || !weights?.size) return 1
  return Math.max(0.75, Math.min(1.8, weights.get(nicheKey(sourceNiche)) || 1))
}

function isRefundedOrder(order: LightweightEbayOrder) {
  const refunds = [
    ...(order.paymentSummary?.refunds || []),
    ...(order.lineItems || []).flatMap((lineItem) => lineItem.refunds || []),
  ]
  const statuses = [order.orderPaymentStatus, ...refunds.map((refund) => refund.refundStatus)]
    .map((status) => String(status || '').toUpperCase())
  const refundedAmount = refunds.reduce((sum, refund) => sum + parsePrice(refund.amount?.value), 0)
  return statuses.includes('FULLY_REFUNDED') || statuses.includes('PARTIALLY_REFUNDED') || refundedAmount > 0
}

function getProductScore(product: Product) {
  const sales = parseSales(product.salesVolume)
  const rating = product._rating && product._rating > 0 ? product._rating : 3.8
  const reviews = product._numRatings ?? 0
  const margin = product.ebayPrice > 0 ? product.profit / product.ebayPrice : 0
  const roi = product.roi / 100
  const imageCount = getProductImageCount(product)
  const demandWeight = Math.log10(sales + 10)
  const ratingWeight = Math.max(0.55, Math.min(1.1, rating / 4.55))
  const reviewWeight = Math.log10(reviews + 25)
  const marginWeight = Math.max(0.38, Math.min(1.55, margin * 3.6))
  const roiWeight = Math.max(0.38, Math.min(1.5, roi * 1.45))
  const reviewTrust = reviews >= 80 ? 1.06 : reviews >= 35 ? 1.03 : reviews < 8 ? 0.93 : 1
  const priceSweetSpot = product.amazonPrice >= 12 && product.amazonPrice <= 120 ? 1.08 : product.amazonPrice > 180 ? 0.78 : 0.95
  const riskPenalty = product.risk === 'HIGH' ? 0.68 : product.risk === 'MEDIUM' ? 0.88 : 1
  const imageWeight = imageCount >= 4 ? 1.1 : imageCount >= 2 ? 1.04 : product.imageUrl ? 0.95 : 0.72
  const contentWeight = getContentReadinessMultiplier(product)
  const sourceQualityWeight = getSourceQualityMultiplier(product.sourceQuality)
  const trendMultiplier = getSourcingTrendMultiplier({
    title: product.title,
    sourceNiche: product.sourceNiche,
    price: product.amazonPrice,
    imageCount,
  })
  const score =
    product.profit *
    demandWeight *
    ratingWeight *
    reviewWeight *
    marginWeight *
    roiWeight *
    priceSweetSpot *
    riskPenalty *
    imageWeight *
    contentWeight *
    sourceQualityWeight *
    reviewTrust *
    trendMultiplier
  return Number.isFinite(score) ? parseFloat(score.toFixed(2)) : 0
}

function getProductImageCount(product: Pick<Product, 'images' | 'imageUrl'>) {
  return Array.from(new Set([
    ...(Array.isArray(product.images) ? product.images : []),
    product.imageUrl,
  ].filter((url): url is string => typeof url === 'string' && url.startsWith('http')))).length
}

function getContentReadinessMultiplier(product: Pick<Product, 'features' | 'description' | 'specs' | 'images' | 'imageUrl'>) {
  const imageCount = getProductImageCount(product)
  const featureCount = Array.isArray(product.features) ? product.features.length : 0
  const specCount = Array.isArray(product.specs) ? product.specs.length : 0
  const hasDescription = String(product.description || '').length >= 100
  let multiplier = imageCount >= 4 ? 1.09 : imageCount >= 2 ? 1.04 : imageCount === 1 ? 0.78 : 0.55
  if (featureCount >= 3) multiplier += 0.04
  if (specCount >= 4) multiplier += 0.03
  if (hasDescription) multiplier += 0.03
  return Math.max(0.5, Math.min(1.18, multiplier))
}

function getSourceQualityMultiplier(sourceQuality?: string) {
  switch (sourceQuality) {
    case 'ready':
      return 1.12
    case 'candidate':
      return 1
    case 'stale':
      return 0.82
    case 'needs_images':
      return 0.7
    case 'reject':
    case 'inactive':
      return 0.12
    default:
      return 0.96
  }
}

function spreadProductsAcrossNiches(products: Product[]) {
  const counts = new Map<string, number>()
  const primary: Product[] = []
  const overflow: Product[] = []
  const maxInitialPerNiche = Math.max(4, Math.ceil(TARGET_STOCK / 5))

  for (const product of products) {
    const key = product.sourceNiche || 'Other'
    const count = counts.get(key) || 0
    counts.set(key, count + 1)
    if (count < maxInitialPerNiche) primary.push(product)
    else overflow.push(product)
  }

  return [...primary, ...overflow]
}

function rankProducts(
  products: Product[],
  options: boolean | { randomize?: boolean; seed?: string; nicheWeights?: Map<string, number>; spreadNiches?: boolean } = false
) {
  const randomize = typeof options === 'boolean' ? options : Boolean(options.randomize)
  const seed = typeof options === 'boolean' ? String(getRotationBucket()) : options.seed || String(getRotationBucket())
  const nicheWeights = typeof options === 'boolean' ? undefined : options.nicheWeights
  const spreadNiches = typeof options === 'boolean' ? false : Boolean(options.spreadNiches)
  const jitterSpread = randomize ? (spreadNiches ? 0.72 : 0.28) : 0

  const ranked = dedupeProducts(products.map(repriceProduct))
    .map((product) => {
      const qualityScore = getProductScore(product)
      const jitter = randomize ? seededRatio(`${seed}:${product.asin}:${product.sourceNiche || ''}`) : 0.5
      const distributionMultiplier = randomize ? 1 - jitterSpread / 2 + jitter * jitterSpread : 1
      const distributionScore = qualityScore * getNicheWeight(nicheWeights, product.sourceNiche) * distributionMultiplier
      return {
        ...product,
        qualityScore,
        distributionScore: Number.isFinite(distributionScore) ? parseFloat(distributionScore.toFixed(2)) : qualityScore,
      }
    })
    .sort((a, b) => {
      if (randomize) return (b.distributionScore || 0) - (a.distributionScore || 0)
      return (b.qualityScore || 0) - (a.qualityScore || 0)
    })

  if (!randomize) return ranked
  return spreadNiches ? spreadProductsAcrossNiches(ranked) : ranked
}

const BASE_NICHE_QUERIES: Record<string, string[]> = {
  'Phone Accessories':      ['phone case wireless charger', 'screen protector tempered glass', 'phone stand holder desk', 'portable battery pack charger'],
  'Computer Parts':         ['usb c hub multiport adapter', 'laptop stand ergonomic adjustable', 'mechanical keyboard compact', 'wireless mouse ergonomic'],
  'Audio & Headphones':     ['wireless earbuds bluetooth noise cancelling', 'portable bluetooth speaker waterproof', 'headphone stand holder', 'aux cable audio'],
  'Smart Home Devices':     ['smart plug wifi outlet alexa', 'smart home security camera indoor', 'smart led bulb color', 'motion sensor alarm'],
  'Gaming Gear':            ['gaming accessories rgb keyboard', 'gaming headset pc ps4', 'gaming chair lumbar support', 'controller grip thumb caps'],
  'Kitchen Gadgets':        ['kitchen gadgets silicone utensils set', 'air fryer accessories baking', 'mandoline slicer vegetables', 'can opener electric automatic'],
  'Home Decor':             ['wall art prints framed bedroom', 'decorative vase home accent', 'throw blanket couch soft', 'scented candle set home'],
  'Furniture & Lighting':   ['led desk lamp usb charging', 'floor lamp living room', 'wall sconce light plug in', 'curtain rod adjustable'],
  'Cleaning Supplies':      ['microfiber cleaning cloths pack', 'cleaning brush kit bathroom', 'mop replacement head flat', 'squeegee window cleaner'],
  'Storage & Organization': ['storage bins organizer closet', 'cable management organizer desk', 'drawer divider organizer bamboo', 'vacuum storage bags space saver'],
  'Camping & Hiking':       ['camping lantern led rechargeable', 'tactical flashlight rechargeable', 'hiking water bottle insulated', 'fire starter emergency kit'],
  'Garden & Tools':         ['garden tools set planting kit', 'pruning shears garden scissors', 'garden hose nozzle spray', 'garden gloves heavy duty', 'kneeling pad gardening foam'],
  'Sporting Goods':         ['resistance bands workout set', 'jump rope speed fitness', 'knee brace support sports', 'wrist wraps gym weightlifting'],
  'Fishing & Hunting':      ['fishing lure kit bass trout', 'braided fishing line 30lb', 'fishing tackle box organizer', 'hunting game camera trail'],
  'Cycling':                ['bike accessories cycling light usb', 'cycling gloves padded gel', 'bike lock combination', 'handlebar grip ergonomic'],
  'Fitness Equipment':      ['resistance bands set workout loop', 'ab roller wheel core', 'foam roller muscle recovery', 'yoga mat non slip thick'],
  'Personal Care':          ['electric facial cleansing brush', 'facial roller jade gua sha', 'hair turban towel microfiber', 'cuticle pusher nail care kit'],
  'Supplements & Vitamins': ['vitamin d3 k2 supplement', 'magnesium glycinate sleep supplement', 'elderberry immune support gummies', 'collagen peptides powder unflavored'],
  'Medical Supplies':       ['pulse oximeter fingertip blood oxygen', 'digital thermometer forehead', 'blood pressure cuff wrist monitor', 'pill organizer weekly daily'],
  'Mental Wellness':        ['essential oil diffuser ultrasonic', 'meditation cushion zafu floor', 'weighted sleep mask eye', 'aromatherapy stress relief'],
  'Car Parts':              ['dash cam front rear camera', 'car phone mount magnetic vent', 'obd2 scanner bluetooth diagnostic', 'jump starter portable battery'],
  'Car Accessories':        ['car organizer back seat trunk', 'car cleaning kit detailing', 'air freshener vent clip', 'seat cover protector universal'],
  'Motorcycle Gear':        ['motorcycle gloves touchscreen riding', 'helmet bluetooth headset', 'motorcycle lock disc brake', 'balaclava face mask riding'],
  'Truck & Towing':         ['truck bed organizer storage', 'towing hitch receiver cover', 'truck tailgate pad cycling', 'bed liner mat rubber'],
  'Car Care':               ['car wash kit microfiber towels', 'windshield wiper blades universal', 'tire pressure gauge digital', 'clay bar detailing kit'],
  'Pet Supplies':           ['dog dental chews tartar control', 'cat interactive toys feather wand', 'pet deshedding brush dog cat', 'dog harness no pull adjustable'],
  'Baby & Kids':            ['baby carrier wrap ergonomic newborn', 'toddler activity toy learning', 'silicone bib waterproof baby', 'diaper bag backpack large'],
  'Toys & Games':           ['fidget toys sensory pack kids', 'card games family fun adults', 'magnetic tiles building blocks', 'kinetic sand moldable'],
  'Clothing & Accessories': ['compression socks athletic women men', 'sun hat wide brim women upf', 'cooling towel sports workout', 'travel wallet rfid blocking'],
  'Jewelry & Watches':      ['minimalist bracelet set women gold', 'watch band replacement silicone', 'jewelry organizer box travel', 'earring set hypoallergenic women'],
  'Office Supplies':        ['desk organizer accessories office', 'ergonomic wrist rest mouse pad', 'standing desk mat anti fatigue', 'label maker tape refill'],
  'Industrial Equipment':   ['safety glasses protective eyewear ansi', 'work gloves mechanic heavy duty', 'ear protection earmuffs noise', 'respirator mask n95 reusable'],
  'Safety Gear':            ['safety vest reflective high visibility', 'hard hat construction vented', 'first aid kit emergency', 'fire extinguisher home small'],
  'Janitorial & Cleaning':  ['heavy duty trash bags industrial 55 gallon', 'floor scrubber brush commercial', 'paper towels bulk pack', 'hand soap refill gallon'],
  'Packaging Materials':    ['bubble mailers padded envelopes', 'shipping boxes packing tape', 'poly mailers shipping bags', 'stretch wrap film clear'],
  'Trading Cards':          ['card sleeves deck protector standard', 'card storage binder 9 pocket', 'card grading sleeves hard case', 'booster box display case'],
  'Vintage & Antiques':     ['vintage style wall clock decor', 'retro tin signs man cave bar', 'antique map print framed', 'vintage record album storage'],
  'Coins & Currency':       ['coin holder album collection', 'magnifying glass loupe jeweler', 'coin tubes storage capsule', 'currency detector pen'],
  'Comics & Manga':         ['manga book storage box', 'comic book bags boards supplies', 'action figure display case', 'anime poster print framed'],
  'Sports Memorabilia':     ['sports card display case frame', 'autograph frame display signed', 'jersey display case shadow box', 'trading card storage box'],
}

const NICHE_QUERIES = mergeTrendingNicheQueries(BASE_NICHE_QUERIES)

function findKnownSourceNiche(value?: string | null) {
  const normalized = nicheKey(value)
  if (!normalized) return null
  return Object.keys(NICHE_QUERIES).find((nicheName) => {
    const known = nicheKey(nicheName)
    return normalized === known || normalized.includes(known) || known.includes(normalized)
  }) || null
}

function inferSourceNiche(...values: Array<string | null | undefined>) {
  const text = normalizeTitle(values.filter(Boolean).join(' '))
  if (!text) return null

  let best: { niche: string; score: number } | null = null
  for (const [sourceNiche, queries] of Object.entries(NICHE_QUERIES)) {
    const nicheText = normalizeTitle(sourceNiche)
    let score = text.includes(nicheText) ? 12 : 0
    const queryWords = new Set(normalizeTitle(queries.join(' ')).split(' ').filter((word) => word.length > 3))
    for (const word of queryWords) {
      if (text.includes(word)) score += 1
    }
    if (score > 0 && (!best || score > best.score)) best = { niche: sourceNiche, score }
  }

  return best && best.score >= 2 ? best.niche : null
}

function dedupeQueryEntries(entries: QueryEntry[]) {
  const seen = new Set<string>()
  const deduped: QueryEntry[] = []

  for (const entry of entries) {
    const query = entry.query.replace(/\s+/g, ' ').trim()
    if (!query) continue
    const key = `${entry.sourceNiche}:${normalizeTitle(query)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({ ...entry, query })
  }

  return deduped
}

function buildNicheQueryEntries(sourceNiche: string, queryMap: NicheQueryMap = NICHE_QUERIES): QueryEntry[] {
  const baseQueries = queryMap[sourceNiche] || [`${sourceNiche} bestseller`]
  const accessoriesQuery = sourceNiche.toLowerCase().includes('accessories')
    ? `${sourceNiche} kit`
    : `${sourceNiche} accessories`
  const expansionQueries = [
    `${sourceNiche} bestseller`,
    `${sourceNiche} best sellers`,
    `top rated ${sourceNiche}`,
    `popular ${sourceNiche}`,
    `trending ${sourceNiche}`,
    `high demand ${sourceNiche}`,
    `${sourceNiche} deals`,
    accessoriesQuery,
    `${sourceNiche} bundle`,
    `${sourceNiche} pack`,
    `${sourceNiche} replacement`,
    `${sourceNiche} set`,
    ...getSeasonalQueryExpansions(sourceNiche),
  ]

  return dedupeQueryEntries([...baseQueries, ...expansionQueries].map((query) => ({ sourceNiche, query })))
}

async function getRecentSoldListingSignals(userId: string) {
  const signals = new Map<string, { units: number; revenue: number }>()

  try {
    const credentials = await getValidEbayAccessToken(userId)
    if (!credentials?.accessToken) return signals

    const base = credentials.sandboxMode ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
    const limit = 100
    let offset = 0

    while (offset < 100) {
      const url = new URL(`${base}/sell/fulfillment/v1/order`)
      url.searchParams.set('limit', String(limit))
      url.searchParams.set('offset', String(offset))

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Language': 'en-US' },
        signal: AbortSignal.timeout(2500),
      }).catch(() => null)

      if (!response?.ok) break
      const payload = await response.json()
      const orders = Array.isArray(payload.orders) ? payload.orders as LightweightEbayOrder[] : []
      for (const order of orders) {
        if (isRefundedOrder(order)) continue
        for (const lineItem of order.lineItems || []) {
          const listingId = String(lineItem.legacyItemId || '')
          if (!listingId) continue
          const current = signals.get(listingId) || { units: 0, revenue: 0 }
          current.units += Math.max(1, Number(lineItem.quantity || 1))
          current.revenue += parsePrice(lineItem.lineItemCost?.value)
          signals.set(listingId, current)
        }
      }

      if (orders.length < limit) break
      offset += limit
    }
  } catch {
    // Sales signals are an optimization only; the queue still works without eBay data.
  }

  return signals
}

async function getUserNicheWeights(userId: string, options: { includeSoldSignals?: boolean } = {}) {
  const weights = new Map<string, number>()
  const includeSoldSignals = options.includeSoldSignals !== false

  try {
    const rows = await queryRows<NichePreferenceRow>`
      SELECT ebay_listing_id, title, niche, category_name, amazon_price, ebay_price, ebay_fee_rate, ended_at
      FROM listed_asins
      WHERE user_id = ${userId}
    `
    const stats = new Map<string, { score: number; listings: number }>()
    const listingRowsById = new Map(rows.filter((row) => row.ebay_listing_id).map((row) => [String(row.ebay_listing_id), row] as const))
    const addNicheScore = (sourceNiche: string, score: number, listingCount = 0) => {
      const key = nicheKey(sourceNiche)
      const current = stats.get(key) || { score: 0, listings: 0 }
      current.score += score
      current.listings += listingCount
      stats.set(key, current)
    }

    for (const row of rows) {
      const sourceNiche = findKnownSourceNiche(row.niche) || inferSourceNiche(row.title, row.category_name, row.niche)
      if (!sourceNiche) continue

      const amazonPrice = parsePrice(row.amazon_price)
      const ebayPrice = parsePrice(row.ebay_price)
      const feeRate = Number(row.ebay_fee_rate) || EBAY_DEFAULT_FEE_RATE
      const metrics = amazonPrice > 0 && ebayPrice > 0
        ? getListingMetrics(amazonPrice, ebayPrice, feeRate)
        : { profit: 0, margin: 0 }
      const estimatedProfit = metrics.profit
      const margin = metrics.margin / 100
      const activeSignal = row.ended_at ? 0.65 : 1
      const rowScore = activeSignal + Math.max(0, estimatedProfit) / 18 + Math.max(0, margin) * 2.4
      addNicheScore(sourceNiche, rowScore, 1)
    }

    if (includeSoldSignals) {
      const soldSignals = await getRecentSoldListingSignals(userId)
      for (const [listingId, signal] of soldSignals) {
        const row = listingRowsById.get(listingId)
        const sourceNiche = findKnownSourceNiche(row?.niche) || inferSourceNiche(row?.title, row?.category_name, row?.niche)
        if (!sourceNiche) continue
        addNicheScore(sourceNiche, signal.units * 3.2 + signal.revenue / 42, 0)
      }
    }

    const maxScore = Math.max(0, ...Array.from(stats.values()).map((stat) => stat.score))
    if (maxScore > 0) {
      for (const [key, stat] of stats) {
        const confidence = Math.min(1, stat.listings / 8)
        const normalizedScore = stat.score / maxScore
        weights.set(key, 1 + normalizedScore * 0.6 + confidence * 0.15)
      }
    }
  } catch {
    // Performance weighting is best-effort; product finding should still work without it.
  }

  return weights
}

function buildContinuousQueryEntries(weights: Map<string, number>, seed: string, queryMap: NicheQueryMap = NICHE_QUERIES): QueryEntry[] {
  const allEntries = Object.keys(queryMap).flatMap((sourceNiche) => buildNicheQueryEntries(sourceNiche, queryMap))
  const weightedLimit = Math.ceil(CONTINUOUS_QUERY_LIMIT * (weights.size > 0 ? 0.72 : 0.5))
  const weightedEntries = allEntries
    .map((entry) => ({
      entry,
      score:
        getNicheWeight(weights, entry.sourceNiche) * (0.82 + seededRatio(`${seed}:weighted:${entry.sourceNiche}:${entry.query}`) * 0.36) +
        seededRatio(`${seed}:explore:${entry.query}`) * 0.16,
    }))
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry)
  const explorationEntries = seededShuffle(allEntries, `${seed}:all-niches`)
  const chosen: QueryEntry[] = []
  const seen = new Set<string>()
  const addEntry = (entry: QueryEntry) => {
    const key = `${entry.sourceNiche}:${entry.query}`
    if (seen.has(key) || chosen.length >= CONTINUOUS_QUERY_LIMIT) return
    seen.add(key)
    chosen.push(entry)
  }

  for (const entry of weightedEntries.slice(0, weightedLimit)) addEntry(entry)
  for (const entry of explorationEntries) addEntry(entry)
  return chosen
}

async function loadContinuousProductsFromNicheCache(limit = 20) {
  try {
    const rows = await queryRows<{ niche: string; results: Product[]; version?: number }>`
      SELECT niche, results, version
      FROM product_cache
      WHERE niche <> ${CONTINUOUS_CACHE_KEY}
      ORDER BY cached_at DESC
      LIMIT ${limit}
    `
    const products: Product[] = []
    const seen = new Set<string>()

    for (const row of rows) {
      const sourceNiche = findKnownSourceNiche(row.niche) || row.niche
      const rowProducts = Array.isArray(row.results) ? row.results : []
      for (const product of rowProducts) {
        if (!product?.asin || seen.has(product.asin.toUpperCase())) continue
        seen.add(product.asin.toUpperCase())
        products.push({ ...product, sourceNiche: product.sourceNiche || sourceNiche })
      }
    }

    return products
  } catch {
    return []
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const mode = req.nextUrl.searchParams.get('mode')
  const continuousMode = mode === 'continuous'
  const requestedNiche = req.nextUrl.searchParams.get('niche')
  const niche = continuousMode ? CONTINUOUS_CACHE_KEY : requestedNiche
  const targetCount = Math.max(1, Math.min(60, Number(req.nextUrl.searchParams.get('limit') || TARGET_STOCK) || TARGET_STOCK))
  const excludeAsins = new Set(
    (req.nextUrl.searchParams.get('exclude') || '')
      .split(',')
      .map((asin) => asin.trim().toUpperCase())
      .filter(Boolean)
  )
  if (!niche) return apiError('Niche is required.', { status: 400, code: 'NICHE_REQUIRED' })

  const forceRefresh = req.nextUrl.searchParams.get('refresh') === '1'
  const liveFetchBudgetMs = continuousMode ? CONTINUOUS_LIVE_FETCH_BUDGET_MS : NICHE_LIVE_FETCH_BUDGET_MS
  const isOutOfLiveFetchTime = () => Date.now() - startedAt > liveFetchBudgetMs

  const userId = String(session.user.id)
  const sourceNicheQueries: NicheQueryMap = {
    ...NICHE_QUERIES,
    ...await withTimeout(loadActiveCustomSourceNicheQueries(), 700, {}),
  }
  const requestSeed = forceRefresh ? `${Date.now()}:${Math.random()}` : String(getRotationBucket())
  const distributionSeed = `${userId}:${continuousMode ? 'continuous' : niche}:${requestSeed}`
  // Defer niche weights until after cache check — avoids eBay API call when cache is warm
  let nicheWeights = new Map<string, number>()

  // ── Load ALL users' active ASINs (cross-user deduplication) ─────────────────
  // Blocks any ASIN already live on eBay by ANY account on the platform.
  // This prevents two users from listing the same product and competing with each other.
  // If a listing ends (sold out or removed), that ASIN becomes available again for everyone.
  let listedAsins = new Set<string>()
  let listedTitles: string[] = []
  try {
    const listedRows = await withTimeout(
      queryRows<{ asin: string; title: string | null; is_mine: boolean }>`
        SELECT asin, title, (user_id = ${session.user.id}) AS is_mine
        FROM listed_asins
        WHERE ended_at IS NULL
        ORDER BY listed_at DESC
        LIMIT 2000
      `,
      continuousMode ? 900 : 1800,
      []
    )
    listedAsins = new Set(listedRows.map((r) => String(r.asin).toUpperCase()))
    // Only use titles from this user's listings for fuzzy-match blocking
    listedTitles = listedRows.filter(r => r.is_mine).map((r) => String(r.title || '')).filter(Boolean)
  } catch { /* table may not exist yet */ }

  const matchesActiveListing = (title: string) =>
    listedTitles.some((listedTitle) => getTitleScore(listedTitle, title) >= 0.82)

  const shouldBlockProduct = (product: Pick<Product, 'asin' | 'title' | 'available'>) =>
    product.available === false ||
    listedAsins.has(product.asin.toUpperCase()) ||
    excludeAsins.has(product.asin.toUpperCase()) ||
    matchesActiveListing(product.title) ||
    isRejected(product.title) ||
    isWeakListingTitle(product.title)

  const getAvailableProducts = (products: Product[]) =>
    rankProducts(products.filter((product) => !shouldBlockProduct(product)), {
      randomize: true,
      seed: distributionSeed,
      nicheWeights,
      spreadNiches: continuousMode,
    })

  const isPublishReadyProduct = (product: Product) =>
    !shouldBlockProduct(product) &&
    getProductImageCount(product) >= 2 &&
    product.profit >= MIN_STOCK_PROFIT &&
    product.roi >= MIN_STOCK_ROI &&
    product.risk !== 'HIGH' &&
    product.sourceQuality !== 'needs_images' &&
    product.sourceQuality !== 'stale'

  const prioritizePublishReadyProducts = (products: Product[]) => {
    const reranked = rankProducts(products.filter((product) => !shouldBlockProduct(product)), {
      randomize: true,
      seed: `${distributionSeed}:publish-ready`,
      nicheWeights,
      spreadNiches: continuousMode,
    })
    const ready = reranked.filter(isPublishReadyProduct)
    const fallback = reranked.filter((product) => !isPublishReadyProduct(product))

    return ready.length > 0
      ? ready
      : fallback
  }

  const scheduleNicheSourceRepair = (reason: string, availableCount: number, readyCount: number) => {
    if (continuousMode) return
    after(async () => {
      try {
        const cronSecret = process.env.CRON_SECRET || ''
        const host = req.nextUrl.origin
        const url = `${host}/api/cron/refresh-products?stockWeak=1&wait=1&batch=1&niche=${encodeURIComponent(niche)}&source=product-finder-repair`
        await fetch(url, {
          headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : { 'x-vercel-cron': '1' },
          signal: AbortSignal.timeout(280000),
        }).catch(() => null)
        console.info('[product-finder-repair]', JSON.stringify({ niche, reason, availableCount, readyCount }))
      } catch {
        // Source repair is opportunistic; the request should never fail because repair did.
      }
    })
  }

  const enrichSparseTopProducts = async (products: Product[]) => {
    const publishReadyCount = products.filter(isPublishReadyProduct).length
    if (publishReadyCount >= targetCount || isOutOfLiveFetchTime()) return products

    const checkedAsins = new Set<string>()
    const enrichedByAsin = new Map<string, Product>()
    const rejectedAsins = new Set<string>()
    const candidates = products
      .filter((product) => !isPublishReadyProduct(product))
      .filter((product) => getProductImageCount(product) < 2 || product.available !== true)
      .slice(0, continuousMode ? 8 : Math.max(targetCount, 24))

    const batchSize = continuousMode ? 2 : 3
    for (let index = 0; index < candidates.length; index += batchSize) {
      if (isOutOfLiveFetchTime()) break
      const batch = candidates.slice(index, index + batchSize)
      await Promise.allSettled(batch.map(async (product) => {
        checkedAsins.add(product.asin.toUpperCase())
        const validated = await fetchAmazonProductByAsin({
          asin: product.asin,
          fallbackImage: product.imageUrl,
          fallbackTitle: product.title,
          fallbackPrice: product.amazonPrice,
          strictAsin: true,
        }).catch(() => null)

        if (!validated || validated.available === false) {
          rejectedAsins.add(product.asin.toUpperCase())
          return null
        }

        const titleScore = getTitleScore(product.title, validated.title)
        const sourceBrand = product.title.split(/\s+/)[0]?.toLowerCase()
        const validatedBrand = validated.title.split(/\s+/)[0]?.toLowerCase()
        const sameBrand = Boolean(sourceBrand && validatedBrand && sourceBrand === validatedBrand)

        if (titleScore < 0.42 && !sameBrand) {
          rejectedAsins.add(product.asin.toUpperCase())
          return null
        }

        const mergedImages = Array.from(new Set([
          ...(Array.isArray(validated.images) ? validated.images : []),
          validated.imageUrl,
          ...(Array.isArray(product.images) ? product.images : []),
          product.imageUrl,
        ].filter((url): url is string => typeof url === 'string' && url.startsWith('http'))))

        const enriched: Product = {
          ...product,
          title: validated.title || product.title,
          amazonPrice: validated.amazonPrice || product.amazonPrice,
          imageUrl: mergedImages[0] || product.imageUrl,
          images: mergedImages,
          features: validated.features?.length ? validated.features : product.features,
          description: validated.description || product.description,
          specs: validated.specs?.length ? validated.specs : product.specs,
          available: validated.available,
          sourceQuality: mergedImages.length >= 2 ? 'ready' : product.sourceQuality,
        }

        if (!isPublishReadyProduct(enriched)) return null
        enrichedByAsin.set(product.asin.toUpperCase(), enriched)
        return enriched
      }))

      const readyCount = products.filter((product) => {
        const enriched = enrichedByAsin.get(product.asin.toUpperCase())
        return isPublishReadyProduct(enriched || product)
      }).length
      if (readyCount >= targetCount) break
    }

    if (rejectedAsins.size > 0) {
      after(async () => {
        await sql`
          UPDATE product_source_items
          SET active = FALSE,
              source_quality = 'reject',
              last_seen_at = NOW(),
              last_intelligence_at = NOW()
          WHERE asin = ANY(${Array.from(rejectedAsins)}::text[])
        `.catch(() => {})
      })
    }

    if (checkedAsins.size === 0) return products
    return products
      .filter((product) => !rejectedAsins.has(product.asin.toUpperCase()))
      .map((product) => enrichedByAsin.get(product.asin.toUpperCase()) || product)
  }

  const respondWithProducts = async (products: Product[], source: string) => {
    let ranked = getAvailableProducts(products)

    // Supplement products that have sparse images/content with data from amazon_product_cache.
    // Catalog-crawl products only store imageUrl (1 image). If this ASIN was ever validated
    // by the niche finder, the full images/features/description are already in the cache.
    // A single batch DB lookup here — no new API calls — fixes bulk listing image/description issues.
    const topRankedAsins = ranked
      .slice(0, Math.max(targetCount, TARGET_STOCK))
      .map(p => p.asin)
    const sparseAsins = ranked
      .filter(p => (p.images?.length ?? 0) < 2)
      .slice(0, targetCount)
      .map(p => p.asin)
    const cacheLookupAsins = Array.from(new Set([...topRankedAsins, ...sparseAsins]))

    if (cacheLookupAsins.length > 0) {
      try {
        const cachedRows = await queryRows<{
          asin: string
          title: string | null
          primary_image: string | null
          images: string[]
          features: string[]
          description: string | null
          specs: Array<[string, string]>
          available: boolean | null
        }>`
          SELECT asin, title, primary_image, images, features, description, specs, available
          FROM amazon_product_cache
          WHERE asin = ANY(${cacheLookupAsins}::text[])
        `
        if (cachedRows.length > 0) {
          const cacheMap = new Map(cachedRows.map(r => [r.asin.toUpperCase(), r]))
          const unavailableAsins = new Set(
            cachedRows
              .filter(r => r.available === false)
              .map(r => r.asin.toUpperCase())
          )
          if (unavailableAsins.size > 0) {
            ranked = ranked.filter(product => !unavailableAsins.has(product.asin.toUpperCase()))
            after(async () => {
              await sql`
                UPDATE product_source_items
                SET active = FALSE, last_seen_at = NOW()
                WHERE asin = ANY(${Array.from(unavailableAsins)}::text[])
              `.catch(() => {})
            })
          }

          const staleMappedAsins = new Set(
            ranked
              .filter((product) => {
                const cached = cacheMap.get(product.asin.toUpperCase())
                return Boolean(cached?.title && getTitleScore(product.title, cached.title) < 0.45)
              })
              .map((product) => product.asin.toUpperCase())
          )
          if (staleMappedAsins.size > 0) {
            ranked = ranked.filter(product => !staleMappedAsins.has(product.asin.toUpperCase()))
            after(async () => {
              await sql`
                UPDATE product_source_items
                SET active = FALSE,
                    source_quality = 'reject',
                    last_seen_at = NOW(),
                    last_intelligence_at = NOW()
                WHERE asin = ANY(${Array.from(staleMappedAsins)}::text[])
              `.catch(() => {})
            })
          }

          ranked = ranked.map(product => {
            if ((product.images?.length ?? 0) >= 2) return product
            const cached = cacheMap.get(product.asin.toUpperCase())
            if (!cached) return product

            const mergedImages = [
              cached.primary_image,
              ...(Array.isArray(cached.images) ? cached.images : []),
            ].filter((u): u is string => typeof u === 'string' && u.startsWith('http'))
            const deduped = Array.from(new Set(mergedImages))
            if (deduped.length < 2) return product  // still sparse — no improvement

            return {
              ...product,
              images: deduped,
              imageUrl: deduped[0] || product.imageUrl,
              available: cached.available ?? product.available,
              features: (product.features?.length ?? 0) > 0
                ? product.features
                : (Array.isArray(cached.features) ? cached.features : product.features),
              description: product.description ||
                (typeof cached.description === 'string' ? cached.description : product.description),
              specs: (product.specs?.length ?? 0) > 0
                ? product.specs
                : (Array.isArray(cached.specs) ? cached.specs : product.specs),
            }
          })
        }
      } catch { /* best-effort — never block on cache lookup failure */ }
    }

    ranked = prioritizePublishReadyProducts(await enrichSparseTopProducts(ranked))
    const readyCount = ranked.filter(isPublishReadyProduct).length
    if (readyCount < Math.min(targetCount, 8)) {
      scheduleNicheSourceRepair('low-publish-ready-count', ranked.length, readyCount)
    }

    // For products still sparse after the cache lookup, schedule background enrichment
    // so the NEXT time the user loads products they'll already have full images/features.
    // Uses after() — runs after response is sent, never delays the user.
    const stillSparseAsins = ranked
      .filter(p => (p.images?.length ?? 0) < 2)
      .slice(0, 12)
      .map(p => ({ asin: p.asin, imageUrl: p.imageUrl }))

    if (stillSparseAsins.length > 0) {
      after(async () => {
        const ENRICH_BATCH = 3
        for (let i = 0; i < stillSparseAsins.length; i += ENRICH_BATCH) {
          const batch = stillSparseAsins.slice(i, i + ENRICH_BATCH)
          await Promise.allSettled(
            batch.map(({ asin, imageUrl }) =>
              fetchAmazonProductByAsin({
                asin,
                fallbackImage: imageUrl,
                strictAsin: false,
              }).catch(() => null)
            )
          )
        }
      })
    }

    console.info('[product-finder]', JSON.stringify({
      mode: continuousMode ? 'continuous' : 'niche',
      source,
      count: Math.min(ranked.length, targetCount),
      available: ranked.length,
      durationMs: Date.now() - startedAt,
    }))
    return apiOk({
      niche: continuousMode ? 'Continuous Listing' : niche,
      mode: continuousMode ? 'continuous' : 'niche',
      results: ranked.slice(0, targetCount),
      count: Math.min(ranked.length, targetCount),
      available: ranked.length,
      source,
    })
  }

  const sourceEngineProducts = await withTimeout(
    loadProductSourceProducts({ niche: continuousMode ? undefined : niche, limit: 600 }),
    continuousMode ? 700 : 1200,
    []
  )
  const sourceEngineAvailable = getAvailableProducts(sourceEngineProducts)
  if (sourceEngineAvailable.length >= targetCount && (!forceRefresh || sourceEngineProducts.length > targetCount)) {
    return respondWithProducts(sourceEngineProducts, continuousMode ? 'source-engine' : 'source-engine-niche')
  }

  // ── Check cache ──────────────────────────────────────────────────────────────
  let cacheRow: { results: Product[]; cached_at: Date; version?: number } | null = null
  try {
    const rows = await queryRows<{ results: Product[]; cached_at: Date; version?: number }>`SELECT results, cached_at, version FROM product_cache WHERE niche = ${niche}`
    if (rows[0]) cacheRow = rows[0] as { results: Product[]; cached_at: Date; version?: number }
  } catch { /* ignore */ }

  const cacheAge = cacheRow ? Date.now() - new Date(cacheRow.cached_at).getTime() : Infinity
  const cacheIsFresh = cacheAge < CACHE_TTL && (cacheRow?.version || 1) === CACHE_VERSION
  const continuousNicheCacheProducts = continuousMode
    ? await withTimeout(loadContinuousProductsFromNicheCache(16), 750, [])
    : []
  const cachedProducts = continuousMode
    ? [...(cacheRow?.results || []), ...continuousNicheCacheProducts]
    : (cacheRow?.results || [])
  const stockedProducts = [...sourceEngineProducts, ...cachedProducts]
  const stockedAvailable = getAvailableProducts(stockedProducts)
  if (stockedAvailable.length >= targetCount && (!forceRefresh || stockedProducts.length > targetCount)) {
    return respondWithProducts(stockedProducts, continuousMode ? 'source-engine-cache' : 'source-engine-cache-niche')
  }
  const cachedAvailable = getAvailableProducts(cachedProducts)

  if (continuousMode && cachedAvailable.length >= targetCount && (!forceRefresh || cachedProducts.length > targetCount)) {
    return respondWithProducts(cachedProducts, forceRefresh ? 'cache-reshuffle' : 'cache')
  }

  if (continuousMode && cachedAvailable.length >= CONTINUOUS_MIN_FAST_RETURN) {
    return respondWithProducts(cachedProducts, forceRefresh ? 'cache-reshuffle-partial' : 'cache-partial')
  }

  if (cacheIsFresh && !forceRefresh) {
    if (cachedAvailable.length >= targetCount) {
      return respondWithProducts(cachedProducts, 'cache')
    }
    // Cache is fresh but below target. Do not return a tiny niche queue;
    // keep the request moving through live sourcing and also kick the
    // background catalog forward so the pool repairs itself for later users.
    if (cachedAvailable.length > 0 && !continuousMode) {
      after(async () => {
        try {
          const cronSecret = process.env.CRON_SECRET || ''
          const host = req.nextUrl.origin
          await fetch(`${host}/api/cron/refresh-products?catalog=1&wait=1&batch=1&niche=${encodeURIComponent(niche)}`, {
            headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
            signal: AbortSignal.timeout(280000),
          })
        } catch { /* background — ignore errors */ }
      })
    }
  }

  // Cache miss — load lightweight DB-only niche weights before live fetch.
  if (continuousMode) {
    nicheWeights = await withTimeout(getUserNicheWeights(userId, { includeSoldSignals: false }), 700, new Map<string, number>())
  }

  // ── Fetch fresh data from StackPilot's own source engine ─────────────────────

  const queryEntries = continuousMode
    ? buildContinuousQueryEntries(nicheWeights, distributionSeed, sourceNicheQueries)
    : buildNicheQueryEntries(niche, sourceNicheQueries)
  const results: Product[] = []
  const fallbackResults: Product[] = []
  const seenAsins = new Set<string>()

  const candidateCount = () => results.length + fallbackResults.length
  const isStockableListing = (amazonPrice: number, ebayPrice: number) => {
    const metrics = getListingMetrics(amazonPrice, ebayPrice, EBAY_DEFAULT_FEE_RATE)
    return metrics.profit >= MIN_STOCK_PROFIT && metrics.roi >= MIN_STOCK_ROI && metrics.margin >= MIN_STOCK_MARGIN
  }
  const hasStrongDemandSignal = (rating: number, reviewCount: number, salesVolume?: string) => {
    const sales = parseSales(salesVolume)
    const ratingOk = rating === 0 || rating >= MIN_PRIMARY_RATING
    const demandOk = reviewCount === 0 || reviewCount >= MIN_PRIMARY_REVIEW_COUNT || sales >= MIN_PRIMARY_SALES
    return ratingOk && demandOk
  }
  const getRisk = (price: number, roi: number, fallback = false) => {
    if (price > 150) return 'HIGH'
    if (price > 60 || roi < 45 || fallback) return 'MEDIUM'
    return 'LOW'
  }
  const addCandidate = (product: Product, primary: boolean) => {
    if (primary) {
      results.push(product)
    } else {
      fallbackResults.push({ ...product, risk: getRisk(product.amazonPrice, product.roi, true) })
    }
  }

  const addScrapedProducts = async (entries: Array<{ query: string; sourceNiche: string }>, queryLimit: number, timeoutMs = 6000) => {
    const selectedEntries = entries.slice(0, queryLimit)
    const parallel = continuousMode ? 2 : 4
    for (let index = 0; index < selectedEntries.length; index += parallel) {
      if (isOutOfLiveFetchTime() || getAvailableProducts(results).length >= targetCount || candidateCount() >= MAX_POOL_SIZE) break
      const batch = selectedEntries.slice(index, index + parallel)
      const settled = await Promise.allSettled(
        batch.map(async ({ query, sourceNiche }) => ({
          sourceNiche,
          products: await scrapeAmazonSearch(query, 1, timeoutMs),
        }))
      )
      for (const outcome of settled) {
        if (outcome.status !== 'fulfilled') continue
        const { sourceNiche, products: scraped } = outcome.value
        for (const p of scraped) {
          if (isOutOfLiveFetchTime() || getAvailableProducts(results).length >= targetCount || candidateCount() >= MAX_POOL_SIZE) break
          if (!p.asin || seenAsins.has(p.asin) || shouldBlockProduct({ asin: p.asin, title: p.title })) continue
          seenAsins.add(p.asin)
          if (!p.price || p.price <= 0 || p.price > MAX_COST) continue
          if (!p.title || isRejected(p.title)) continue
          const { ebayPrice, profit, roi } = calcMetrics(p.price)
          const healthy = isHealthyListing(p.price, ebayPrice, EBAY_DEFAULT_FEE_RATE)
          if (p.rating > 0 && p.rating < MIN_ACCEPTABLE_RATING) continue
          if (!healthy && !isStockableListing(p.price, ebayPrice)) continue
          const primary = healthy && hasStrongDemandSignal(p.rating, p.reviewCount)
          const risk = getRisk(p.price, roi, !primary)
          addCandidate({ asin: p.asin, title: p.title, amazonPrice: p.price, ebayPrice, profit, roi,
            imageUrl: p.imageUrl, risk, salesVolume: undefined, sourceNiche, _rating: p.rating, _numRatings: p.reviewCount }, primary)
        }
      }
    }
  }

  const mergeStockedProducts = () => {
    if (stockedProducts.length === 0) return
    const seen = new Set(results.map((product) => product.asin.toUpperCase()))
    const stocked = stockedProducts.filter((product) => {
      const asin = product.asin.toUpperCase()
      if (seen.has(asin)) return false
      seen.add(asin)
      return true
    })
    results.splice(0, results.length, ...rankProducts([...results, ...stocked], false))
  }

  const mergeFallbackProducts = () => {
    if (fallbackResults.length === 0 || getAvailableProducts(results).length >= targetCount) return
    const seen = new Set(results.map((product) => product.asin.toUpperCase()))
    const fallback = fallbackResults.filter((product) => {
      const asin = product.asin.toUpperCase()
      if (seen.has(asin) || shouldBlockProduct(product)) return false
      seen.add(asin)
      return true
    })
    if (fallback.length === 0) return
    results.splice(0, results.length, ...rankProducts([...results, ...fallback], false))
  }

  const saveResultsToCache = async (productsToSave = results) => {
    if (productsToSave.length === 0) return
    try {
      const repriced = productsToSave.map(repriceProduct)
      await sql`
        INSERT INTO product_cache (niche, results, version) VALUES (${niche}, ${JSON.stringify(rankProducts(repriced, false))}, ${CACHE_VERSION})
        ON CONFLICT (niche) DO UPDATE SET results = EXCLUDED.results, version = EXCLUDED.version, cached_at = NOW()
      `
    } catch { /* non-fatal */ }
  }

  const ingestProductsToSourceEngine = (productsToIngest = results, provider = 'finder') =>
    upsertProductSourceItems(productsToIngest.map((product) => ({
      ...product,
      sourceNiche: product.sourceNiche || (continuousMode ? undefined : niche) || undefined,
      sourceProvider: provider,
    }))).catch(() => 0)

  const scheduleCacheSave = (productsToSave = results) => {
    const snapshot = rankProducts([...productsToSave].map(repriceProduct), false)
    after(async () => {
      await saveResultsToCache(snapshot)
      await ingestProductsToSourceEngine(snapshot)
    })
  }

  // StackPilot does not depend on RapidAPI for sourcing. The live pass below
  // uses direct Amazon search scraping and supplements any partial cache.

  // ── Save fresh results to cache ──────────────────────────────────────────────
  if (getAvailableProducts(results).length < targetCount) {
    mergeFallbackProducts()
  }

  if (results.length > 0) {
    results.splice(0, results.length, ...rankProducts(results, false))
    if (continuousMode) {
      // Continuous Listing should return fast; cache writes happen when we return below.
    } else {
      const enrichmentCount = targetCount

      const enriched = await Promise.all(
        results.slice(0, enrichmentCount).map(async (product) => {
          const validated = await fetchAmazonProductByAsin({
            asin: product.asin,
            fallbackImage: product.imageUrl,
            fallbackTitle: product.title,
            fallbackPrice: product.amazonPrice,
            strictAsin: true,
          }).catch(() => null)

          if (!validated) return product
          const titleScore = getTitleScore(product.title, validated.title)
          const sameBrand =
            product.title.split(/\s+/)[0]?.toLowerCase() &&
            validated.title.split(/\s+/)[0]?.toLowerCase() &&
            product.title.split(/\s+/)[0].toLowerCase() === validated.title.split(/\s+/)[0].toLowerCase()

          if (titleScore < 0.42 && !sameBrand) {
            return null
          }

          return {
            ...product,
            title: validated.title || product.title,
            amazonPrice: validated.amazonPrice || product.amazonPrice,
            imageUrl: validated.imageUrl || product.imageUrl,
            images: validated.images,
            features: validated.features,
            description: validated.description,
            specs: validated.specs,
            available: validated.available,
          }
        })
      )

      const filteredEnriched = dedupeProducts(enriched.filter((product): product is Product => Boolean(product)))
      const droppedSourceAsins = new Set(
        results
          .slice(0, enrichmentCount)
          .map((product) => product.asin)
          .filter((asin) => !filteredEnriched.some((product) => product.asin === asin))
      )
      const remainder = results.slice(enrichmentCount).filter((product) => !droppedSourceAsins.has(product.asin))
      results.splice(0, results.length, ...rankProducts([...filteredEnriched, ...remainder], false))

      await saveResultsToCache()
      after(() => ingestProductsToSourceEngine([...results]))
    }
  }

  // ── Direct Amazon scrape, then fall back to cache ───────────────────────────
  if (results.length === 0) {
    mergeStockedProducts()
    if (continuousMode && getAvailableProducts(results).length > 0) {
      return respondWithProducts(results, 'cache')
    }

    // Scrape Amazon search directly (free, no quota). This also supplements
    // partial caches so niche pages do not get stuck showing only a few items.
    await addScrapedProducts(queryEntries, continuousMode ? 1 : Math.min(queryEntries.length, 10), continuousMode ? 1800 : 6000)
    mergeFallbackProducts()

    if (results.length > 0) {
      results.splice(0, results.length, ...rankProducts(results, false))
      if (continuousMode) scheduleCacheSave()
      else {
        await saveResultsToCache()
        after(() => ingestProductsToSourceEngine([...results]))
      }
      return respondWithProducts(results, 'scrape')
    }

    return apiError('Product search is temporarily unavailable. Try again in a few minutes.', {
      status: 503,
      code: 'PRODUCT_SEARCH_UNAVAILABLE',
      details: { niche, results: [], count: 0 },
    })
  }

  if (getAvailableProducts(results).length < targetCount) {
    mergeStockedProducts()
  }

  if (continuousMode && getAvailableProducts(results).length === 0 && !isOutOfLiveFetchTime()) {
    await addScrapedProducts(queryEntries, 1, 1800)
    mergeFallbackProducts()
  }

  if (continuousMode && getAvailableProducts(results).length > 0) {
    results.splice(0, results.length, ...rankProducts(results, false))
    scheduleCacheSave()
    return respondWithProducts(results, getAvailableProducts(results).length >= targetCount ? 'live' : 'live-partial')
  }

  if (!continuousMode && getAvailableProducts(results).length < targetCount) {
    await addScrapedProducts(queryEntries, Math.min(queryEntries.length, 10), 6000)
    mergeFallbackProducts()
    results.splice(0, results.length, ...rankProducts(results, false))
    await saveResultsToCache()
    after(() => ingestProductsToSourceEngine([...results]))
  }

  return respondWithProducts(results, 'live')
}
