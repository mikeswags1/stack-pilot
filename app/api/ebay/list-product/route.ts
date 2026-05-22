import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { ensureSubscriptionRow, getTrialUsage, getUserPlan, releaseTrialListingSlot, reserveTrialListingSlot } from '@/lib/subscription'
import { apiError, apiOk } from '@/lib/api-response'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows, sql } from '@/lib/db'
import { ensureListedAsinsFinancialColumns } from '@/lib/listed-asins'
import { fetchAmazonProductByAsin, loadCachedAmazonProduct, saveCachedAmazonProduct } from '@/lib/amazon-product'
import { scrapeAmazonProduct } from '@/lib/amazon-scrape'
import { checkAmazonLiveAvailability } from '@/lib/amazon-availability'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getPricingRecommendation, getRecommendedEbayPrice } from '@/lib/listing-pricing'
import { getListingPolicyBlockReason, getListingPolicyFlags, hasBlockedListingPolicyFlag } from '@/lib/listing-policy'
import { chooseBestListingTitle, isWeakListingTitle } from '@/lib/listing-quality'
import { getRapidApiKey } from '@/lib/rapidapi'

// ── VeRO Protection ──────────────────────────────────────────────────────────
// VERO / brand protection is handled entirely by lib/listing-policy.ts
// (HIGH_RISK_BRAND_RULES, RESTRICTED_ITEM_RULES, etc.) which is called at
// lines ~1388 and ~1914. No separate isVero check is needed here.

// ── eBay Category IDs ────────────────────────────────────────────────────────
const NICHE_CATEGORY: Record<string, string> = {
  'Phone Accessories':     '9394',
  'Computer Parts':        '58058',
  'Audio & Headphones':    '14985',
  'Smart Home Devices':    '183406',
  'Gaming Gear':           '117042',
  'Golf Accessories':      '15273',
  'Pool Products':         '2032',
  'Beach & Sunny Day':     '16034',
  'Summer Outdoor Gear':   '16034',
  'Backyard & Patio':      '2032',
  'Travel Accessories':    '93838',
  'Fitness Recovery':      '15273',
  'Home Organization':     '26677',
  'Pet Products':          '1281',
  'Viral Gadgets':         '293',
  'Giftable Under $50':    '99',
  'Kitchen Gadgets':       '20625',
  'Home Decor':            '10033',
  'Furniture & Lighting':  '95672',
  'Cleaning Supplies':     '26677',
  'Storage & Organization':'26677',
  'Camping & Hiking':      '16034',
  'Garden & Tools':        '2032',
  'Sporting Goods':        '15273',
  'Fishing & Hunting':     '1492',
  'Cycling':               '2904',   // Bicycle Accessories & Gear
  'Fitness Equipment':     '15273',
  'Personal Care':         '26248',
  'Supplements & Vitamins':'180960',
  'Medical Supplies':      '51148',
  'Mental Wellness':       '26395',
  'Car Parts':             '6030',
  'Car Accessories':       '14946',
  'Motorcycle Gear':       '10063',
  'Truck & Towing':        '6030',
  'Car Care':              '179716',
  'Pet Supplies':          '1281',
  'Baby & Kids':           '2984',
  'Toys & Games':          '19169',
  'Clothing & Accessories':'11450',
  'Jewelry & Watches':     '137839',
  'Office Supplies':       '26215',
  'Industrial Equipment':  '12576',
  'Safety Gear':           '177742',
  'Janitorial & Cleaning': '26677',
  'Packaging Materials':   '26677',
  'Trading Cards':         '183050',
  'Vintage & Antiques':    '20081',
  'Coins & Currency':      '11116',
  'Comics & Manga':        '259104',
  'Sports Memorabilia':    '64482',
}

const NICHE_FALLBACK_LEAF_CATEGORY: Record<string, string> = {
  'Phone Accessories':      '9394',
  'Computer Parts':         '58058',
  'Audio & Headphones':     '14985',
  'Smart Home Devices':     '183406',
  'Gaming Gear':            '139971',
  'Golf Accessories':       '15273',
  'Pool Products':          '2032',
  'Beach & Sunny Day':      '16034',
  'Summer Outdoor Gear':    '16034',
  'Backyard & Patio':       '2032',
  'Travel Accessories':     '93838',
  'Fitness Recovery':       '15273',
  'Home Organization':      '26677',
  'Pet Products':           '1281',
  'Viral Gadgets':          '293',
  'Giftable Under $50':     '99',
  'Kitchen Gadgets':        '20625',
  'Home Decor':             '10033',
  'Furniture & Lighting':   '95672',
  'Cleaning Supplies':      '26677',   // Cleaning Supplies & Products
  'Storage & Organization': '26677',   // Cleaning Supplies & Products (closest match)
  'Camping & Hiking':       '16034',
  'Garden & Tools':         '2032',    // Garden
  'Sporting Goods':         '15273',   // Sporting Goods
  'Fishing & Hunting':      '1492',    // Fishing
  'Cycling':                '2904',
  'Fitness Equipment':      '15273',   // Sporting Goods
  'Personal Care':          '26248',
  'Supplements & Vitamins': '180960',
  'Medical Supplies':       '51148',   // Medical, Mobility & Disability Equipment
  'Mental Wellness':        '26395',   // Vitamins & Lifestyle Supplements (closest wellness match)
  'Car Parts':              '6030',    // Car & Truck Parts & Accessories
  'Car Accessories':        '14946',
  'Motorcycle Gear':        '10063',   // Motorcycle Parts
  'Truck & Towing':         '6030',    // Car & Truck Parts & Accessories
  'Car Care':               '179716',  // Car Care
  'Pet Supplies':           '1281',
  'Baby & Kids':            '2984',
  'Toys & Games':           '19169',
  'Clothing & Accessories': '11450',   // Clothing, Shoes & Accessories
  'Jewelry & Watches':      '281',     // Jewelry & Watches
  'Office Supplies':        '26215',
  'Industrial Equipment':   '12576',   // Industrial Equipment & Supplies
  'Safety Gear':            '177742',  // Safety & Security
  'Janitorial & Cleaning':  '26677',   // Cleaning Supplies & Products
  'Packaging Materials':    '26677',   // Cleaning Supplies & Products (closest match)
  'Trading Cards':          '183050',
  'Vintage & Antiques':     '20081',   // Antiques
  'Coins & Currency':       '11116',   // Coins & Paper Money
  'Comics & Manga':         '259104',
  'Sports Memorabilia':     '64482',
}

const DEFAULT_LEAF_CATEGORY = '26677'
const EBAY_SHIP_FROM_LOCATION = 'King City, California, United States'
const EBAY_SHIP_FROM_POSTAL_CODE = '93930'

const TITLE_FALLBACK_CATEGORY_RULES: Array<{ categoryId: string; keywords: string[] }> = [
  { categoryId: '9394', keywords: ['phone', 'iphone', 'galaxy', 'samsung', 'magsafe', 'charger', 'charging case', 'screen protector'] },
  { categoryId: '58058', keywords: ['computer', 'laptop', 'keyboard', 'mouse', 'usb', 'monitor', 'webcam', 'ssd', 'hard drive'] },
  { categoryId: '14985', keywords: ['headphone', 'earbud', 'speaker', 'audio', 'bluetooth', 'microphone', 'soundbar'] },
  { categoryId: '183406', keywords: ['smart home', 'wifi', 'wi-fi', 'alexa', 'google home', 'security camera', 'smart plug'] },
  { categoryId: '139971', keywords: ['gaming', 'controller', 'xbox', 'playstation', 'switch', 'rgb', 'gamepad'] },
  { categoryId: '15273', keywords: ['golf', 'pickleball', 'massage ball', 'foam roller', 'recovery strap', 'sports accessory'] },
  { categoryId: '2032', keywords: ['pool', 'patio', 'backyard', 'garden', 'grill', 'solar pathway', 'outdoor light'] },
  { categoryId: '16034', keywords: ['beach', 'camping', 'hiking', 'cooler backpack', 'dry bag', 'outdoor gear'] },
  { categoryId: '93838', keywords: ['travel', 'luggage', 'passport', 'packing cube', 'toiletry bag', 'luggage scale'] },
  { categoryId: '20625', keywords: ['kitchen', 'cookware', 'utensil', 'knife', 'coffee', 'pan', 'baking', 'food storage'] },
  { categoryId: '10033', keywords: ['decor', 'wall art', 'vase', 'candle', 'pillow cover', 'throw pillow', 'curtain'] },
  { categoryId: '95672', keywords: ['lamp', 'lighting', 'table', 'desk', 'chair', 'shelf', 'furniture', 'nightstand'] },
  { categoryId: '26677', keywords: ['cleaning', 'towel', 'paper towel', 'trash bag', 'storage', 'organizer', 'box', 'bin', 'tape', 'packaging'] },
  { categoryId: '16034', keywords: ['camping', 'hiking', 'tent', 'cooler', 'backpack', 'outdoor'] },
  { categoryId: '2032', keywords: ['garden', 'tool', 'hose', 'plant', 'lawn', 'yard', 'drill', 'wrench'] },
  { categoryId: '15273', keywords: ['fitness', 'workout', 'yoga', 'exercise', 'sporting', 'sports', 'brace', 'resistance band'] },
  { categoryId: '1492', keywords: ['fishing', 'hunting', 'tackle', 'lure', 'reel', 'rod'] },
  { categoryId: '2904', keywords: ['bike', 'bicycle', 'cycling', 'helmet', 'pedal'] },
  { categoryId: '26248', keywords: ['personal care', 'beauty', 'hair', 'skin', 'grooming', 'toothbrush'] },
  { categoryId: '51148', keywords: ['medical', 'health', 'bandage', 'first aid', 'mobility', 'support'] },
  { categoryId: '6030', keywords: ['car', 'auto', 'automotive', 'truck', 'vehicle', 'obd', 'towing'] },
  { categoryId: '1281', keywords: ['pet', 'dog', 'cat', 'aquarium', 'leash', 'collar'] },
  { categoryId: '2984', keywords: ['baby', 'toddler', 'kids', 'child', 'diaper', 'stroller'] },
  { categoryId: '19169', keywords: ['toy', 'game', 'puzzle', 'doll', 'playset'] },
  { categoryId: '11450', keywords: ['clothing', 'shirt', 'pants', 'sock', 'jacket', 'hoodie', 'hat', 'shoe'] },
  { categoryId: '281', keywords: ['jewelry', 'watch', 'necklace', 'bracelet', 'earring', 'ring'] },
  { categoryId: '26215', keywords: ['office', 'desk', 'pen', 'paper', 'printer', 'label', 'folder'] },
  { categoryId: '12576', keywords: ['industrial', 'commercial', 'safety sign', 'warehouse'] },
  { categoryId: '177742', keywords: ['safety', 'ppe', 'glove', 'goggles', 'hard hat', 'reflective'] },
  { categoryId: '183050', keywords: ['trading card', 'pokemon card', 'sports card'] },
  { categoryId: '20081', keywords: ['vintage', 'antique', 'collectible'] },
  { categoryId: '11116', keywords: ['coin', 'currency', 'silver round', 'banknote'] },
  { categoryId: '259104', keywords: ['comic', 'manga', 'graphic novel'] },
  { categoryId: '64482', keywords: ['memorabilia', 'signed', 'autograph', 'jersey'] },
]

function inferFallbackCategoryFromTitle(title: string, niche: string | null | undefined) {
  const nicheCategory = NICHE_FALLBACK_LEAF_CATEGORY[niche || ''] || NICHE_CATEGORY[niche || '']
  if (nicheCategory) return nicheCategory

  const normalized = title.toLowerCase()
  const match = TITLE_FALLBACK_CATEGORY_RULES.find((rule) =>
    rule.keywords.some((keyword) => normalized.includes(keyword))
  )
  return match?.categoryId || DEFAULT_LEAF_CATEGORY
}

const NICHE_SPECIFICS: Record<string, Array<[string, string]>> = {
  'Audio & Headphones':    [['Connectivity', 'Wireless'], ['Type', 'Bluetooth Speaker']],
  'Phone Accessories':     [['Compatible Brand', 'Universal'], ['Type', 'Phone Accessory']],
  'Computer Parts':        [['Interface', 'USB'], ['Type', 'Computer Accessory']],
  'Smart Home Devices':    [['Connectivity', 'Wi-Fi'], ['Type', 'Smart Home Device']],
  'Gaming Gear':           [['Compatible Platform', 'PC, PlayStation, Xbox, Nintendo Switch'], ['Type', 'Gaming Accessory']],
  'Kitchen Gadgets':       [['Material', 'See Description'], ['Type', 'Kitchen Gadget']],
  'Home Decor':            [['Theme', 'Modern'], ['Type', 'Home Décor Accent']],
  'Furniture & Lighting':  [['Type', 'Desk Lamp'], ['Power Source', 'Electric']],
  'Cleaning Supplies':     [['Type', 'Cleaning Kit'], ['Surface Recommendation', 'Universal']],
  'Storage & Organization':[['Type', 'Storage Bin'], ['Material', 'Plastic']],
  'Camping & Hiking':      [['Type', 'Outdoor Gear'], ['Activity', 'Camping, Hiking']],
  'Garden & Tools':        [['Type', 'Garden Tool'], ['Material', 'See Description']],
  'Sporting Goods':        [['Type', 'Sporting Goods'], ['Activity', 'Fitness']],
  'Fishing & Hunting':     [['Type', 'Fishing Gear'], ['Activity', 'Fishing']],
  'Cycling':               [['Type', 'Cycling Accessory'], ['Activity', 'Cycling']],
  'Fitness Equipment':     [['Type', 'Fitness Accessory'], ['Activity', 'Exercise & Fitness']],
  'Personal Care':         [['Type', 'Personal Care Device'], ['Power Source', 'Battery Operated']],
  'Supplements & Vitamins':[['Type', 'Dietary Supplement'], ['Form', 'Capsule']],
  'Medical Supplies':      [['Type', 'Medical Supply'], ['For', 'Adults']],
  'Mental Wellness':       [['Type', 'Wellness Accessory'], ['Scent', 'See Description']],
  'Car Parts':             [['Placement on Vehicle', 'Universal'], ['Type', 'Car Accessory']],
  'Car Accessories':       [['Placement on Vehicle', 'Universal'], ['Type', 'Car Accessory']],
  'Motorcycle Gear':       [['Type', 'Motorcycle Accessory'], ['Material', 'See Description']],
  'Truck & Towing':        [['Placement on Vehicle', 'Universal'], ['Type', 'Truck Accessory']],
  'Car Care':              [['Type', 'Car Care Kit'], ['Surface Recommendation', 'All Surfaces']],
  'Pet Supplies':          [['Animal Type', 'Dog, Cat'], ['Type', 'Pet Accessory']],
  'Baby & Kids':           [['Age Range', 'Toddler'], ['Type', 'Baby Accessory']],
  'Toys & Games':          [['Age Level', '3+'], ['Type', 'Game']],
  'Clothing & Accessories':[['Department', 'Unisex Adults'], ['Size Type', 'Regular']],
  'Jewelry & Watches':     [['Metal', 'See Description'], ['Type', 'Fashion Jewelry']],
  'Office Supplies':       [['Type', 'Office Accessory'], ['Material', 'See Description']],
  'Industrial Equipment':  [['Type', 'Safety Equipment'], ['Material', 'See Description']],
  'Safety Gear':           [['Type', 'Safety Gear'], ['Material', 'See Description']],
  'Janitorial & Cleaning': [['Type', 'Cleaning Supply'], ['Surface Recommendation', 'Universal']],
  'Packaging Materials':   [['Type', 'Packaging Supply'], ['Material', 'See Description']],
  'Trading Cards':         [['Card Condition', 'Near Mint or Better'], ['Type', 'Card Supplies']],
  'Vintage & Antiques':    [['Style', 'Vintage'], ['Type', 'Collectible']],
  'Coins & Currency':      [['Type', 'Coin Collecting Supply'], ['Material', 'See Description']],
  'Comics & Manga':        [['Type', 'Comic Storage'], ['Material', 'Plastic']],
  'Sports Memorabilia':    [['Type', 'Display Case'], ['Material', 'See Description']],
}

// ── Content helpers ──────────────────────────────────────────────────────────
interface AmazonDetails {
  images: string[]
  features: string[]
  description: string
  specs: Array<[string, string]>
}

// Require at least 1 image (not 2). Pool products carry imageUrl (1 image) until
// the background cache enrichment cron fetches the full gallery. The eBay API
// accepts single-image listings. Requiring 2 here was blocking ~90% of the pool.
const MIN_LISTING_IMAGES = 1

function isGenericFeature(value: string) {
  const normalized = value.toLowerCase()
  return (
    normalized.includes('brand new and factory sealed') ||
    normalized.includes('premium quality') ||
    normalized.includes('simple setup') ||
    normalized.includes('easy to store and carry') ||
    normalized.includes('excellent gift') ||
    normalized.includes('ships fast via usps') ||
    normalized.includes('30-day hassle-free returns') ||
    normalized.includes('practical general accessory') ||
    normalized.includes('practical') && normalized.includes('for everyday use') ||
    normalized.startsWith('brand shown in item specifics') ||
    normalized.includes('review the photos and item specifics for exact details') ||
    normalized.includes('review the photos and item specifics for the exact style') ||
    normalized.includes('key product details are included in the images')
  )
}

function hasRichAmazonContent(input: { images?: string[]; features?: string[]; description?: string }) {
  return (input.images?.length || 0) >= 2 || (input.features?.length || 0) >= 3 || String(input.description || '').length >= 120
}

function chooseBestDescription(...values: Array<string | undefined>) {
  return values
    .map((value) => sanitizeContent(String(value || '')))
    .filter((value) => value.length > 20)
    .sort((a, b) => b.length - a.length)[0] || ''
}

function sanitizeContent(text: string): string {
  return decodeAllEntities(text)
    .replace(/\b(amazon\.?com?|amazon prime|prime\s+shipping|prime\s+eligible|prime\s+member|fulfilled\s+by\s+amazon|ships\s+from\s+amazon|sold\s+by\s+amazon|amazon\s+basics|amazon\s+brand|buy\s+on\s+amazon|visit\s+the\s+\S+\s+store|fba)\b/gi, '')
    .replace(/\b(amazon[''']?s?\s+choice|overall\s+pick|#?\s*1\s+best\s+seller|best\s+seller|limited\s+time\s+deal|climate\s+pledge\s+friendly|small\s+business|sponsored|top\s+brand|highly\s+rated|deal\s+of\s+the\s+day)\b/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>&"]/g, ' ')
    // Strip leading emoji that Amazon includes in bullet points
    .replace(/^[\u{1F300}-\u{1FFFF}\u{2600}-\u{27FF}\s]+/u, '')
    // Strip control characters invalid in XML 1.0 (causes XML Parse error)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/class=\S+|data-[a-z-]+=\S+|aplus[-\w]*|widget[-\w]*|background-image\s*:[^;]+;?|position\s*:[^;]+;?|padding\s*:[^;]+;?|margin\s*:[^;]+;?|width\s*:[^;]+;?|height\s*:[^;]+;?|display\s*:[^;]+;?/gi, ' ')
    .replace(/[{};]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function canonicalWords(value: string) {
  return sanitizeContent(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 2)
}

function detectVariantWords(title: string, specs: Array<[string, string]>) {
  const allowed = new Set<string>()
  for (const word of canonicalWords(title)) allowed.add(word)
  for (const [key, value] of specs) {
    if (/color|colour|style|size|variation|pattern|flavor|flavour|finish/i.test(key)) {
      for (const word of canonicalWords(value)) allowed.add(word)
    }
  }
  return allowed
}

function filterVariantSpecificImages(values: string[], title: string, specs: Array<[string, string]>) {
  const allowedWords = detectVariantWords(title, specs)
  if (allowedWords.size === 0) return values
  const blocked = ['pink', 'purple', 'blue', 'green', 'red', 'coffee', 'brown', 'black', 'white', 'ivory', 'beige', 'silver', 'gold']

  const filtered = values.filter((value, index) => {
    if (index === 0) return true
    const normalized = value.toLowerCase()
    const matchedBlocked = blocked.filter((word) => normalized.includes(word))
    if (matchedBlocked.length === 0) return true
    return matchedBlocked.every((word) => allowedWords.has(word))
  })

  return filtered.length > 0 ? filtered : values
}

function dedupeSpecEntries(values: Array<[string, string]>) {
  const seen = new Set<string>()
  const rows: Array<[string, string]> = []
  for (const [key, value] of values) {
    const rowKey = `${key.toLowerCase()}::${value.toLowerCase()}`
    if (seen.has(rowKey)) continue
    seen.add(rowKey)
    rows.push([key, value])
  }
  return rows
}

function decodeAllEntities(input: string): string {
  return input
    .replace(/&#0*34;?/g, '"')
    .replace(/&#0*39;?/g, "'")
    .replace(/&#0*38;?/g, '&')
    .replace(/&#0*60;?/g, '<')
    .replace(/&#0*62;?/g, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')   // strip any remaining numeric entities
    .replace(/&[a-z]+;/gi, ' ') // strip any remaining named entities
}

function sanitizeDescriptionText(input: string) {
  return decodeAllEntities(input)
    .split(/\n+/)
    .map((line) => sanitizeContent(line))
    .filter((line) => line.length > 35)
    .filter((line) => !/(data-csa|aplus|widget|module|desktop|wrapper|padding|margin|background-image|function|position relative|display table)/i.test(line))
    .filter((line) => !/(click to play|watch the video|how to add|visit the .* store|learn more|amazon.?s choice|prime|customer review)/i.test(line))
    .filter((line) => !/[{}]/.test(line))
    // Strip lines that are mostly Amazon marketing/promotional content
    .filter((line) => !/(no\.?\s*1\s+amazon|licensed distributor|millions of customers|featured in|star tribune|msn news|must-have travel|over \d+ years|travel sentry|unconditional.*support|after sales|selected as)/i.test(line))
    .join(' ')
    .trim()
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Look up the correct eBay category by searching existing listings for this ASIN.
// Real listings always use leaf categories — this is the most accurate source possible.
async function getCategoryByAsin(asin: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(asin)}&limit=10&fieldgroups=MATCHING_ITEMS`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!res.ok) return null
    const data = await res.json() as { itemSummaries?: Array<{ categories?: Array<{ categoryId?: string }> }> }
    const items = data.itemSummaries || []
    if (items.length === 0) return null

    // Tally categories across results — most common = most reliable
    const tally: Record<string, number> = {}
    for (const item of items) {
      const catId = item.categories?.[0]?.categoryId
      if (catId) tally[catId] = (tally[catId] || 0) + 1
    }
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1])
    return sorted[0]?.[0] || null
  } catch {
    return null
  }
}

function getCategoryTitleScore(query: string, candidate: string) {
  const queryWords = new Set(canonicalWords(query).filter((word) => word.length > 2))
  const candidateWords = new Set(canonicalWords(candidate).filter((word) => word.length > 2))
  if (queryWords.size === 0 || candidateWords.size === 0) return 0

  let overlap = 0
  for (const word of queryWords) {
    if (candidateWords.has(word)) overlap += 1
  }

  const queryCoverage = overlap / queryWords.size
  const candidateCoverage = overlap / candidateWords.size
  return (queryCoverage * 0.7) + (candidateCoverage * 0.3)
}

function parsePriceValue(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const parsed = parseFloat(String(value || '').replace(/[^0-9.]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

async function getComparableEbayPrices(title: string, token: string, amazonPrice: number) {
  const query = title
    .split(/\s+/)
    .slice(0, 9)
    .join(' ')
    .trim()
  if (!query) return { prices: [] as number[], count: 0 }

  try {
    const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '24')
    url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW}')

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(4500),
    })
    if (!res.ok) return { prices: [] as number[], count: 0 }

    const data = await res.json() as {
      itemSummaries?: Array<{
        title?: string
        price?: { value?: string }
        shippingOptions?: Array<{ shippingCost?: { value?: string } }>
      }>
    }
    const prices: number[] = []

    for (const item of data.itemSummaries || []) {
      const score = getCategoryTitleScore(title, String(item.title || ''))
      if (score < 0.38) continue

      const itemPrice = parsePriceValue(item.price?.value)
      const shipping = parsePriceValue(item.shippingOptions?.[0]?.shippingCost?.value)
      const landedPrice = itemPrice + shipping
      if (landedPrice <= 0) continue
      if (landedPrice < Math.max(3, amazonPrice * 0.65)) continue
      if (landedPrice > Math.max(amazonPrice * 5, amazonPrice + 80)) continue
      prices.push(Number(landedPrice.toFixed(2)))
    }

    return { prices: Array.from(new Set(prices)).sort((a, b) => a - b), count: prices.length }
  } catch {
    return { prices: [] as number[], count: 0 }
  }
}

// Use categories from real active eBay listings with similar titles.
// This catches cases where Taxonomy returns a valid but too-generic/wrong category.
async function getCategoryByComparableListings(title: string, token: string): Promise<string | null> {
  try {
    const query = title
      .split(/\s+/)
      .slice(0, 10)
      .join(' ')
      .trim()
    if (!query) return null

    const res = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=20&fieldgroups=MATCHING_ITEMS`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!res.ok) return null

    const data = await res.json() as {
      itemSummaries?: Array<{
        title?: string
        categories?: Array<{ categoryId?: string }>
      }>
    }
    const tally = new Map<string, { count: number; score: number }>()

    for (const item of data.itemSummaries || []) {
      const categoryId = item.categories?.[0]?.categoryId
      const score = getCategoryTitleScore(title, String(item.title || ''))
      if (!categoryId || score < 0.42) continue

      const current = tally.get(categoryId) || { count: 0, score: 0 }
      tally.set(categoryId, { count: current.count + 1, score: current.score + score })
    }

    const ranked = Array.from(tally.entries())
      .filter(([categoryId]) => categoryId !== '29223')
      .sort((a, b) => b[1].score - a[1].score)
    const best = ranked[0]
    const second = ranked[1]
    if (!best) return null
    if (best[1].count < 2 && best[1].score < 0.75) return null
    if (second && best[1].score - second[1].score < 0.2) return null

    return best[0]
  } catch {
    return null
  }
}

// eBay Taxonomy REST API — purpose-built for category selection, semantic matching,
// always returns leaf categories. Significantly more accurate than GetSuggestedCategories.
async function getTaxonomyCategoryIds(title: string, token: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(title)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!res.ok) return []
    const data = await res.json() as {
      categorySuggestions?: Array<{
        category?: { categoryId?: string; categoryName?: string }
        categoryTreeNodeAncestors?: Array<{ categoryId?: string }>
      }>
    }
    const suggestions = data.categorySuggestions || []
    return suggestions
      .map(s => s.category?.categoryId)
      .filter((id): id is string => Boolean(id))
      .slice(0, 6)
  } catch {
    return []
  }
}

// Legacy Trading API fallback — kept as backup only
async function getSuggestedCategoryIds(title: string, appId: string, token: string): Promise<string[]> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSuggestedCategoriesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <Query>${title.replace(/&/g, '&amp;').replace(/[<>]/g, '')}</Query>
</GetSuggestedCategoriesRequest>`

  try {
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetSuggestedCategories',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(8000),
    })
    const text = await res.text()
    const suggestionBlocks = [...text.matchAll(/<SuggestedCategory>([\s\S]*?)<\/SuggestedCategory>/g)]
      .map((match) => match[1])
    const leafCandidates = suggestionBlocks
      .map((block) => {
        const ids = [...block.matchAll(/<CategoryID>(\d+)<\/CategoryID>/g)].map((match) => match[1])
        return ids[ids.length - 1]
      })
      .filter((value): value is string => Boolean(value))
    if (leafCandidates.length > 0) return Array.from(new Set(leafCandidates))
    const allIds = [...text.matchAll(/<CategoryID>(\d+)<\/CategoryID>/g)].map((match) => match[1])
    return Array.from(new Set(allIds)).reverse()
  } catch {
    return []
  }
}

async function isLeafCategory(categoryId: string, appId: string, token: string): Promise<boolean> {
  if (!categoryId) return false
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetCategoryFeaturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <CategoryID>${categoryId}</CategoryID>
  <DetailLevel>ReturnAll</DetailLevel>
  <ViewAllNodes>false</ViewAllNodes>
</GetCategoryFeaturesRequest>`

  try {
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetCategoryFeatures',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(12000),
    })
    const text = await res.text()
    const categoryBlock =
      text.match(new RegExp(`<Category>[^]*?<CategoryID>${categoryId}<\\/CategoryID>[^]*?<LeafCategory>(true|false)<\\/LeafCategory>[^]*?<\\/Category>`, 'i')) ||
      text.match(new RegExp(`<CategoryID>${categoryId}<\\/CategoryID>[^]*?<LeafCategory>(true|false)<\\/LeafCategory>`, 'i'))

    if (categoryBlock?.[1]) {
      return categoryBlock[1].toLowerCase() === 'true'
    }

    const leafMatch = text.match(/<LeafCategory>(true|false)<\/LeafCategory>/i)
    if (leafMatch?.[1]) {
      return leafMatch[1].toLowerCase() === 'true'
    }

    return false
  } catch {
    return false
  }
}

async function getLeafCategoryCandidates(categoryIds: string[], appId: string, token: string) {
  const validated: string[] = []

  for (const categoryId of categoryIds) {
    if (!categoryId || validated.includes(categoryId)) continue
    if (await isLeafCategory(categoryId, appId, token)) {
      validated.push(categoryId)
    }
  }

  return validated
}

function buildCategorySearchQueries(title: string, niche: string | null) {
  const stopWords = new Set(['with', 'for', 'the', 'and', 'set', 'pack', 'kit', 'new'])
  const titleKeywords = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
    .slice(0, 5)

  return Array.from(
    new Set(
      [
        title,
        titleKeywords.join(' '),
        niche || '',
        niche && titleKeywords.length > 0 ? `${niche} ${titleKeywords.join(' ')}` : '',
      ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  )
}

function toParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((part) => sanitizeContent(part))
    .flatMap((part) => part.split(/(?<=[.!?])\s+(?=[A-Z0-9])/))
    .map((part) => part.trim())
    .filter((part) => part.length > 35)
    .slice(0, 3)
}

function titleCaseLabel(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function canonicalizeImageUrl(value: string) {
  try {
    const url = new URL(value)
    const normalizedPath = url.pathname
      .replace(/\._[^./]+(?=\.[a-z0-9]+$)/i, '')
      .replace(/\.[A-Z0-9,_-]+\.(jpg|jpeg|png|webp)$/i, '.$1')
      .replace(/%2B/gi, '+')
    return `${url.hostname}${normalizedPath}`.toLowerCase()
  } catch {
    return value
      .replace(/\?.*$/, '')
      .replace(/\._[^./]+(?=\.[a-z0-9]+$)/i, '')
      .toLowerCase()
  }
}

function dedupeImageUrls(values: Array<string | undefined | null>) {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const value of values) {
    if (!value || !value.startsWith('http')) continue
    const key = canonicalizeImageUrl(value)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(value)
  }

  return unique
}

function getSpecValue(specs: Array<[string, string]>, pattern: RegExp) {
  const match = specs.find(([key, value]) => pattern.test(key) && value.length > 1)
  return match ? sanitizeContent(match[1]).slice(0, 120) : ''
}

function inferBrandFromProduct(title: string, specs: Array<[string, string]>) {
  const brandSpec = specs.find(([key]) => /brand/i.test(key))
  if (brandSpec?.[1]) return sanitizeContent(brandSpec[1]).slice(0, 80)
  const firstWord = sanitizeContent(title).split(/\s+/)[0] || ''
  return firstWord.length > 1 ? firstWord.slice(0, 80) : ''
}

function inferTypeFromProduct(title: string, niche: string | null, specs: Array<[string, string]>) {
  const typeSpec = specs.find(([key]) => /^type$/i.test(key))
  if (typeSpec?.[1]) return sanitizeContent(typeSpec[1]).slice(0, 120)

  const normalizedTitle = sanitizeContent(title).toLowerCase()
  if (/magnesium|vitamin|supplement|capsule|gummy|softgel|glycinate|mineral/.test(normalizedTitle)) return 'Dietary Supplement'
  if (/bracelet|necklace|ring|earring|pendant|anklet|jewelry/.test(normalizedTitle)) return 'Bracelet'
  if (/camera|security cam|indoor cam|surveillance/.test(normalizedTitle)) return 'Security Camera'
  if (/first aid|medical kit|emergency kit/.test(normalizedTitle)) return 'First Aid Kit'
  if (/flashlight|torch|lantern/.test(normalizedTitle)) return 'Flashlight'
  if (/sock|socks/.test(normalizedTitle)) return 'Athletic Socks'
  if (/toy|montessori|activity desk/.test(normalizedTitle)) return 'Educational Toy'
  if (/jersey frame|shadow box|display case/.test(normalizedTitle)) return 'Display Case'
  if (/headphone|earbud|speaker/.test(normalizedTitle)) return 'Audio Accessory'
  if (/phone case|charger|mount|screen protector/.test(normalizedTitle)) return 'Phone Accessory'

  const nicheDefaults: Record<string, string> = {
    'Smart Home Devices': 'Smart Home Device',
    'Safety Gear': 'Safety Equipment',
    'Medical Supplies': 'Medical Supply',
    'Sporting Goods': 'Sporting Goods',
    'Fitness Equipment': 'Fitness Accessory',
    'Camping & Hiking': 'Outdoor Gear',
    'Kitchen Gadgets': 'Kitchen Gadget',
    'Pet Supplies': 'Pet Accessory',
    'Phone Accessories': 'Phone Accessory',
    'Computer Parts': 'Computer Accessory',
    'Audio & Headphones': 'Audio Accessory',
  }

  return niche ? nicheDefaults[niche] || 'General Accessory' : 'General Accessory'
}

function pickRelevantSpecs(specs: Array<[string, string]>) {
  const skipKeys = /customer|review|rating|star|bought|month|seller|return|warranty|asin|date first|best seller|discontinued|department|item model|upc|ean|isbn|manufacturer part|is discontinued/i
  return dedupeSpecEntries(specs)
    .filter(([key, value]) => key.length > 1 && value.length > 1 && !skipKeys.test(key))
    .slice(0, 14)
}

function buildItemSpecificsXml(title: string, specs: Array<[string, string]>, fallbackXml: string, niche: string | null) {
  const relevantSpecs = pickRelevantSpecs(specs)
  const nameMap = new Map<string, string>()

  const brand = inferBrandFromProduct(title, relevantSpecs)
  nameMap.set('Brand', brand || 'Generic')
  nameMap.set('Type', inferTypeFromProduct(title, niche, relevantSpecs))

  const preferredKeys = [
    'Model',
    'Compatible Brand',
    'Connectivity',
    'Color',
    'Material',
    'Features',
    'Power Source',
    'Screen Size',
    'Resolution',
    'Storage Capacity',
    'Operating System',
    'Sport',
    'Activity',
  ]

  for (const preferred of preferredKeys) {
    const match = relevantSpecs.find(([key]) => key.toLowerCase() === preferred.toLowerCase())
    if (match?.[1]) nameMap.set(preferred, sanitizeContent(match[1]).slice(0, 120))
  }

  for (const [key, value] of relevantSpecs) {
    if (nameMap.size >= 8) break
    const cleanKey = titleCaseLabel(key).slice(0, 80)
    if (!cleanKey || nameMap.has(cleanKey)) continue
    nameMap.set(cleanKey, sanitizeContent(value).slice(0, 120))
  }

  if (nameMap.size === 0) {
    return `<NameValueList><Name>Brand</Name><Value>${inferBrandFromProduct(title, specs) || 'Generic'}</Value></NameValueList>
      <NameValueList><Name>Type</Name><Value>${inferTypeFromProduct(title, niche, specs)}</Value></NameValueList>${fallbackXml}`
  }

  return Array.from(nameMap.entries())
    .map(([name, value]) => `\n      <NameValueList><Name>${name}</Name><Value>${value}</Value></NameValueList>`)
    .join('')
}

function buildOriginalFeatureBullets(title: string, specs: Array<[string, string]>, niche: string | null) {
  const t = title.toLowerCase()
  const bullets: string[] = []

  // Extract meaningful attributes from the title itself
  const wattMatch = title.match(/(\d+)\s*(?:watt|w)\s*(?:equivalent|eq\.?)?/i)
  if (wattMatch) bullets.push(`${wattMatch[1]}W Equivalent — Energy-efficient LED replaces a standard ${wattMatch[1]}-watt bulb, saving on electricity costs.`)

  const packMatch = title.match(/(\d+)\s*(?:-?\s*pack|piece|pc|count|ct)\b/i)
  if (packMatch && Number(packMatch[1]) > 1) bullets.push(`${packMatch[1]}-Pack — Includes ${packMatch[1]} units, great for multi-room or bulk use.`)

  if (/\bwi-?fi\b|\bwireless\b/i.test(title)) bullets.push('WiFi Connected — Control from anywhere using a smartphone app, even when you\'re away from home.')
  if (/\bbluetooth\b/i.test(title)) bullets.push('Bluetooth Enabled — Pairs quickly with your phone for easy wireless control and setup.')
  if (/\bcolor.chang|rgb|rgbw|multicolor|multi-color/i.test(title)) bullets.push('Full Color Control — Choose from millions of colors plus warm and cool white to match any mood or room.')
  if (/\balexa|google home|homekit|siri|voice control/i.test(title)) bullets.push('Voice Control Ready — Works with Alexa, Google Home, and Apple HomeKit for hands-free operation.')
  if (/\brechargeable|usb.c|usb charge/i.test(title)) bullets.push('USB Rechargeable — Built-in rechargeable battery, no disposables needed. Charge with any USB cable.')
  if (/\bwaterproof|water.resist|ipx?\d/i.test(title)) bullets.push('Water Resistant — Designed to handle splashes and moisture, safe for outdoor or bathroom use.')
  if (/\bno.?touch|touchless|infrared|non-?contact/i.test(title)) bullets.push('No-Touch Design — Accurate readings in 1 second without physical contact — hygienic and safe for the whole family.')
  if (/\bvacuum.seal|space.sav|compression bag/i.test(title)) bullets.push('Space Saving — Vacuum seal removes air to compress bulky items like comforters and clothes down to a fraction of their size.')

  // Spec-derived bullets
  const material = getSpecValue(specs, /material|fabric|finish/i)
  const compatibility = getSpecValue(specs, /compatible brand|compatible model|compatibility/i)
  const size = getSpecValue(specs, /size|dimensions/i)
  const connectivity = getSpecValue(specs, /connectivity|interface/i)
  const powerSource = getSpecValue(specs, /power source/i)

  if (material) bullets.push(`Material: ${material} — durable construction built for everyday use.`)
  if (compatibility) bullets.push(`Compatible with: ${compatibility}.`)
  if (size) bullets.push(`Size: ${size} — check the photos and item specifics for exact fit.`)
  if (connectivity && !/wifi|bluetooth/i.test(connectivity)) bullets.push(`Connectivity: ${connectivity}.`)
  if (powerSource && !/rechargeable/i.test(t)) bullets.push(`Power: ${powerSource}.`)

  // Niche-specific contextual bullets when title is sparse
  if (bullets.length < 3) {
    const nicheExtras: Record<string, string[]> = {
      'Smart Home Devices': ['Easy App Setup — Download the free app and connect in minutes. No hub required.', 'Schedule & Automate — Set timers, schedules, and routines so your home works for you.'],
      'Kitchen Gadgets': ['Easy to Clean — Dishwasher-safe or wipes clean in seconds.', 'Compact Storage — Designed to fit neatly in any kitchen drawer or cabinet.'],
      'Pet Supplies': ['Pet Safe — Non-toxic materials, designed with your pet\'s safety in mind.', 'Durable Build — Reinforced construction stands up to daily use by active pets.'],
      'Fitness Equipment': ['Full Body Workout — Targets multiple muscle groups for an efficient home gym session.', 'Compact & Portable — Folds or rolls up for easy storage at home or on the go.'],
      'Personal Care': ['Gentle Formula — Dermatologist tested and suitable for all skin types.', 'Fast Results — See a noticeable difference with regular daily use.'],
      'Car Accessories': ['Universal Fit — Designed to fit most car models. Check item specifics to confirm compatibility.', 'Easy Install — No tools required. Installs in minutes.'],
      'Home Decor': ['Premium Finish — Adds a polished, modern look to any room.', 'Versatile Style — Coordinates with a wide range of decor styles and color schemes.'],
      'Office Supplies': ['Desk Ready — Keeps your workspace organized and efficient.', 'Sturdy Construction — Built to hold up through years of daily office use.'],
    }
    const extras = nicheExtras[niche || ''] || []
    for (const extra of extras) {
      if (bullets.length >= 6) break
      bullets.push(extra)
    }
  }

  // Final fallback if we still have nothing useful
  if (bullets.length === 0) {
    const type = inferTypeFromProduct(title, niche, specs).toLowerCase()
    bullets.push(`Brand new ${type} — ships in original packaging, ready to use out of the box.`)
    bullets.push('Free 2–4 day tracked shipping included with every order.')
    bullets.push('30-day returns accepted — contact us before leaving feedback and we will make it right.')
  }

  return Array.from(new Set(bullets)).slice(0, 8)
}


async function fetchAmazonDetails(
  asin: string, rapidKey: string, fallbackImage?: string
): Promise<AmazonDetails & { _apiError?: string }> {
  const DEFAULT_FEATURES: string[] = []

  // Optional external API fallback. By default StackPilot uses direct scraping.
  if (rapidKey) {
    try {
      const url = `https://real-time-amazon-data.p.rapidapi.com/product-details?asin=${asin}&country=US`
      const res = await fetch(url, {
        headers: {
          'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com',
          'x-rapidapi-key': rapidKey,
        },
        signal: AbortSignal.timeout(8000),
      })

      // If quota/rate-limit hit, fall through to scraper
      if (res.status !== 429 && res.status !== 403) {
        const json = await res.json()
        const data = json?.data ?? json
        const quotaMsg = String(data?.message || '').toLowerCase()
        if (!quotaMsg.match(/limit|quota|exceed/)) {
          const rawPhotos: unknown[] = (Array.isArray(data.product_photos) && data.product_photos.length > 0)
            ? data.product_photos
            : []
          const extractUrl = (v: unknown): string => {
            if (typeof v === 'string') return v
            if (v && typeof v === 'object') {
              const o = v as Record<string, unknown>
              return String(o.url || o.large || o.hiRes || o.main || o.thumb || '')
            }
            return ''
          }
          const mainImg: string =
            extractUrl(rawPhotos[0]) ||
            (typeof data.product_photo === 'string' ? data.product_photo : '') ||
            fallbackImage || ''
          const allImages = Array.from(
            new Set(
              [mainImg, ...rawPhotos.map(extractUrl)]
                .filter((u): u is string => typeof u === 'string' && u.startsWith('http'))
            )
          ).slice(0, 12)

          const rawFeatures: unknown[] = (
            data.about_product || data.feature_bullets || data.bullet_points ||
            data.product_features || data.highlights || data.key_features || []
          )
          const features = (Array.isArray(rawFeatures) ? rawFeatures as string[] : [])
            .filter((f): f is string => typeof f === 'string' && f.trim().length > 5)
            .map(f => sanitizeContent(f).slice(0, 500))
            .filter(f => f.length > 5)

          const rawDesc: string = (
            data.product_description || data.description || data.synopsis ||
            data.product_information || data.full_description || ''
          )
          const description = typeof rawDesc === 'string' ? sanitizeContent(rawDesc).slice(0, 6000) : ''

          const rawSpecs: Record<string, unknown> = {
            ...(data.product_overview ?? {}),
            ...(data.product_details ?? {}),
          }
          const skipKeys = /customer|review|rating|star|bought|month|seller|return|warranty|asin|date first|best seller|discontinued|department|item model|upc|ean|isbn/i
          const specs: Array<[string, string]> = Object.entries(rawSpecs)
            .filter(([k, v]) => k && v && String(v).length > 0 && !skipKeys.test(k))
            .slice(0, 30)
            .map(([k, v]) => [sanitizeContent(k).slice(0, 80), sanitizeContent(String(v)).slice(0, 200)])
            .filter(([k, v]) => k.length > 1 && v.length > 1) as Array<[string, string]>

          const finalFeatures = features.length > 0
            ? features
            : specs.length > 0 ? specs.slice(0, 8).map(([k, v]) => `${k}: ${v}`) : DEFAULT_FEATURES

          return {
            images: allImages.length > 0 ? allImages : (fallbackImage ? [fallbackImage] : []),
            features: finalFeatures,
            description,
            specs,
          }
        }
      }
    } catch { /* fall through to scraper */ }
  }

  // Fallback: scrape Amazon directly (free, no quota)
  try {
    const scraped = await scrapeAmazonProduct(asin)
    if (scraped) {
      const features = scraped.features.length > 0
        ? scraped.features.map(f => sanitizeContent(f))
        : scraped.specs.length > 0
          ? scraped.specs.slice(0, 8).map(([k, v]) => `${k}: ${v}`)
          : DEFAULT_FEATURES
      return {
        images: scraped.images.length > 0 ? scraped.images : (fallbackImage ? [fallbackImage] : []),
        features,
        description: sanitizeContent(scraped.description || ''),
        specs: scraped.specs,
      }
    }
  } catch { /* ignore scrape errors */ }

  return {
    images: fallbackImage ? [fallbackImage] : [],
    features: DEFAULT_FEATURES,
    description: '',
    specs: [],
    _apiError: 'quota_exceeded_scrape_failed',
  }
}

async function uploadToEPS(externalUrl: string, token: string, appId: string): Promise<string> {
  try {
    const safeUrl = externalUrl.replace(/&/g, '&amp;').replace(/[<>]/g, '')
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ExternalPictureURL>${safeUrl}</ExternalPictureURL>
  <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>`
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
        'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID || '',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    const fullUrl = text.match(/<FullURL>(.*?)<\/FullURL>/)?.[1]
    if (fullUrl) return fullUrl
    const err = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || text.slice(0, 300)
    console.error('[EPS]', err.slice(0, 200))
  } catch (e) {
    console.error('[EPS] fetch error:', e instanceof Error ? e.message : e)
  }
  return ''
}

// ── Description builder ──────────────────────────────────────────────────────
function buildDescription(title: string, features: string[], about: string, images: string[], specs: Array<[string, string]> = [], listingNiche: string | null = null): string {

  // Decode all HTML entities so &#039; → ' and &#034; → " etc. render correctly
  const displayTitle = decodeAllEntities(title)

  const uniqueImages = dedupeImageUrls(images)
  const relevantSpecs = pickRelevantSpecs(specs)
  const inferredBrand = inferBrandFromProduct(displayTitle, relevantSpecs)
  const productType = inferTypeFromProduct(displayTitle, null, relevantSpecs)
  const normalizedFeatures = buildOriginalFeatureBullets(displayTitle, relevantSpecs, null)
  const sourceFeatureBullets = features
    .map((value) => sanitizeContent(value))
    .filter((value) => value.length > 12 && !isGenericFeature(value))
    .slice(0, 8)
  const specBullets = relevantSpecs
    .filter(([key]) => !/brand/i.test(key))
    .slice(0, 8)
    .map(([key, value]) => `${titleCaseLabel(key)}: ${value}`)
  const finalBullets = Array.from(new Set([...sourceFeatureBullets, ...normalizedFeatures, ...specBullets])).slice(0, 12)
  const topSpecsSentence = relevantSpecs
    .filter(([key]) => !/brand/i.test(key))
    .slice(0, 4)
    .map(([key, value]) => `${titleCaseLabel(key)} ${value}`)
    .join(', ')
  const featureSummary = finalBullets
    .slice(0, 4)
    .map((value) => value.replace(/: /g, ' '))
    .join(', ')
  // SEO-rich overview — includes product type, brand, and niche keywords buyers search
  const nicheSearchTerms: Record<string, string> = {
    'Phone Accessories': 'cell phone accessories universal compatible protective case cover',
    'Computer Parts': 'laptop desktop computer accessories USB ergonomic compatible',
    'Audio & Headphones': 'wireless bluetooth audio headphones earbuds speaker sound',
    'Smart Home Devices': 'smart home WiFi alexa google home voice control app',
    'Gaming Gear': 'gaming accessories RGB mechanical controller PC Xbox PlayStation',
    'Kitchen Gadgets': 'kitchen gadget cooking baking tool BPA free dishwasher safe',
    'Home Decor': 'home decor modern living room bedroom wall accent decor',
    'Fitness Equipment': 'home gym workout exercise training resistance adjustable',
    'Pet Supplies': 'dog cat pet supplies accessories safe durable easy clean',
    'Car Accessories': 'car accessories universal fit SUV truck interior auto',
    'Office Supplies': 'desk organizer home office work from home professional',
    'Baby & Kids': 'baby kids toddler BPA free non-toxic safe newborn',
    'Toys & Games': 'educational toy STEM interactive ages 3 plus kids',
    'Clothing & Accessories': 'unisex adjustable lightweight casual everyday wear gift',
    'Jewelry & Watches': 'fashion jewelry stainless steel hypoallergenic gift elegant',
    'Camping & Hiking': 'outdoor camping hiking waterproof lightweight portable survival',
    'Garden & Tools': 'garden outdoor tool heavy duty stainless steel ergonomic',
    'Sporting Goods': 'sports athletic training gym outdoor performance all season',
    'Medical Supplies': 'medical grade accurate digital professional FDA approved',
  }
  const nicheTerms = nicheSearchTerms[listingNiche || ''] || 'everyday use home outdoor gift'
  const generatedOverview = `${displayTitle}${inferredBrand ? ` by ${inferredBrand}` : ''} — ${productType} designed for dependable everyday performance. ${nicheTerms.split(' ').slice(0, 6).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} | Free 2–4 day tracked shipping. 30-day returns.`
  const generatedDetails = topSpecsSentence
    ? `Specifications: ${topSpecsSentence}. See photos and item specifics for exact style, size, and included components.`
    : `See all photos and item specifics for exact style, fit, color, and included components before purchasing.`

  // Overview always uses clean generated content — no Amazon text dump
  const overviewBlock = [generatedOverview, generatedDetails]
    .map((p) => `<p style="font-size:15px;line-height:1.85;padding:14px 18px 0;margin:0 0 12px;color:#333;">${p}</p>`)
    .join('\n')

  // Bold ALL-CAPS feature headers before the dash: "TITLE – description" → "<strong>TITLE</strong> – description"
  const formatBullet = (text: string) =>
    text.replace(/^([A-Z][A-Z0-9 &,'().]{3,}?)\s*[–—-]\s*/, '<strong>$1</strong> – ')

  const heroImages = uniqueImages.slice(0, 2)
  const detailImages = uniqueImages.slice(2, 4)
  const heroImageBlock = heroImages.length > 0
    ? `<div style="display:flex;gap:12px;justify-content:center;align-items:flex-start;padding:16px 0 10px;flex-wrap:wrap;">
${heroImages.map(u => `      <img src="${u}" alt="" style="width:${heroImages.length === 1 ? '360px' : '250px'};max-width:100%;height:250px;object-fit:contain;border:1px solid #e6e6e6;border-radius:8px;background:#fafafa;">`).join('\n')}
    </div>`
    : ''
  const detailImageBlock = detailImages.length > 0
    ? `<div style="display:flex;gap:12px;justify-content:center;align-items:flex-start;padding:8px 0 0;flex-wrap:wrap;">
${detailImages.map(u => `      <img src="${u}" alt="" style="width:210px;max-width:100%;height:210px;object-fit:contain;border:1px solid #e6e6e6;border-radius:8px;background:#fafafa;">`).join('\n')}
    </div>`
    : ''

  // Spec table
  const specRows = relevantSpecs
    .slice(0, 12)
    .map(([k, v]) => `<tr><td style="font-weight:700;padding:8px 12px;width:38%;border-bottom:1px solid #eee;font-size:14px;">${titleCaseLabel(k)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;">${v}</td></tr>`)
    .join('\n')

  const sectionHeader = (label: string) =>
    `<div style="background:#6e6e6e;color:#fff;text-align:center;padding:11px 14px;font-size:15px;font-weight:700;letter-spacing:0.04em;margin-top:18px;border-radius:2px;">${label}</div>`

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:#222;background:#fff;box-sizing:border-box;">
<div style="max-width:760px;margin:0 auto;padding:18px 14px 28px;box-sizing:border-box;overflow:hidden;border:1px solid #d8d8d8;border-radius:8px;">

  <!-- Title -->
  <h1 style="font-size:28px;font-weight:700;padding:10px 10px 14px;margin:0;border-bottom:1px solid #e4e4e4;line-height:1.35;word-wrap:break-word;overflow-wrap:anywhere;text-align:center;">${displayTitle}</h1>

  <!-- Product images -->
  ${heroImageBlock}

  <!-- Overview -->
  ${sectionHeader('Product Overview')}
  ${overviewBlock}

  <!-- Features -->
  ${sectionHeader('Product Features')}
  ${finalBullets.length > 0
    ? `<ul style="font-size:14px;line-height:1.75;padding:16px 18px 16px 36px;margin:0;color:#222;overflow-wrap:anywhere;">
    ${finalBullets.map(f => `<li style="margin-bottom:14px;">${formatBullet(f)}</li>`).join('\n')}
  </ul>`
    : `<p style="font-size:14px;line-height:1.8;padding:14px 18px;margin:0;color:#333;">Key product details are included in the images and item specifics for this listing.</p>`}

  <!-- Specs (if available) -->
  ${specRows ? `${sectionHeader('Specifications')}<table style="width:100%;border-collapse:collapse;margin-top:2px;"><tbody>${specRows}</tbody></table>` : ''}

  <!-- Additional Images -->
  ${detailImageBlock}

  <!-- Shipping -->
  ${sectionHeader('Shipping')}
  <ul style="font-size:14px;line-height:1.9;padding:12px 14px 12px 30px;margin:0;color:#333;">
    <li><strong>Free 2&ndash;4 Day Shipping:</strong> Every order includes free expedited tracked shipping.</li>
    <li><strong>Handling:</strong> Ships same day or next business day after cleared payment.</li>
    <li><strong>Tracking:</strong> Tracking is uploaded to eBay as soon as your order ships.</li>
  </ul>

  <!-- Return Policy -->
  ${sectionHeader('Return Policy')}
  <ul style="font-size:14px;line-height:1.9;padding:12px 14px 12px 30px;margin:0;color:#333;">
    <li><strong>30-Day Returns:</strong> Not satisfied? Return within 30 days for a full refund or exchange.</li>
    <li><strong>No Restocking Fee:</strong> We cover return shipping and charge no restocking fees.</li>
    <li><strong>Fast Refunds:</strong> Refunds processed within 1 business day of receiving the return.</li>
  </ul>

  <!-- Feedback -->
  ${sectionHeader('Feedback')}
  <p style="font-size:14px;line-height:1.9;padding:12px 14px;margin:0;color:#333;">
    Your satisfaction is our priority. If you are happy with your purchase, please leave positive feedback.
    If there is any issue, contact us <strong>before</strong> leaving feedback &mdash; we will make it right.
  </p>

  <!-- Contact -->
  ${sectionHeader('Contact Us')}
  <p style="font-size:14px;line-height:1.9;padding:12px 14px;margin:0;color:#333;">
    Questions? Message us through eBay. We respond within 24 hours, Monday&ndash;Friday 9am&ndash;5pm EST.
  </p>

  <!-- Footer -->
  <p style="text-align:center;font-size:14px;font-weight:400;padding:24px 14px 6px;margin:0;border-top:1px solid #e4e4e4;color:#666;letter-spacing:0.01em;">
    Thank you for supporting our small business.
  </p>

</div>
</body>
</html>`

  const safeHtml = html
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/]]>/g, ']] >')
  return `<![CDATA[${safeHtml}]]>`
}



// ── Auth helper ──────────────────────────────────────────────────────────────
// ── eBay API call ────────────────────────────────────────────────────────────
async function callEbayTradingApi(callName: string, xml: string, appId: string, token: string): Promise<string> {
  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-APP-NAME': appId,
      'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
      'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID || '',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'text/xml',
    },
    body: xml,
  })
  return res.text()
}

async function submitToEbay(xml: string, appId: string, token: string): Promise<string> {
  return callEbayTradingApi('AddFixedPriceItem', xml, appId, token)
}

async function verifyToEbay(xml: string, appId: string, token: string): Promise<string> {
  return callEbayTradingApi('VerifyAddFixedPriceItem', xml, appId, token)
}

function buildXml(params: {
  token: string; safeTitle: string; description: string; categoryId: string
  price: string; pictureXml: string; itemSpecificsXml: string; sourceAsin?: string; shippingService?: string; requestType?: 'add' | 'verify'; simplifiedShipping?: boolean
}) {
  const rootTag = params.requestType === 'verify' ? 'VerifyAddFixedPriceItemRequest' : 'AddFixedPriceItemRequest'
  const shippingService = params.shippingService || 'FedEx2Day'
  const shippingDetailsXml = params.simplifiedShipping
    ? `<ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>${shippingService}</ShippingService>
        <ShippingServiceCost currencyID="USD">0.00</ShippingServiceCost>
        <FreeShipping>true</FreeShipping>
        <ExpeditedService>true</ExpeditedService>
      </ShippingServiceOptions>
    </ShippingDetails>`
    : `<ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>${shippingService}</ShippingService>
        <ShippingServiceCost currencyID="USD">0.00</ShippingServiceCost>
        <FreeShipping>true</FreeShipping>
        <ExpeditedService>true</ExpeditedService>
        <ShippingServiceAdditionalCost currencyID="USD">0.00</ShippingServiceAdditionalCost>
      </ShippingServiceOptions>
    </ShippingDetails>`
  return `<?xml version="1.0" encoding="utf-8"?>
<${rootTag} xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${params.token}</eBayAuthToken>
  </RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <Title>${params.safeTitle}</Title>
    ${params.sourceAsin ? `<SKU>EBAYDASH-${params.sourceAsin}</SKU>` : ''}
    <Description>${params.description}</Description>
    <PrimaryCategory><CategoryID>${params.categoryId}</CategoryID></PrimaryCategory>
    <StartPrice>${params.price}</StartPrice>
    <ConditionID>1000</ConditionID>
    <Country>US</Country>
    <Currency>USD</Currency>
    <Location>${EBAY_SHIP_FROM_LOCATION.replace(/&/g, '&amp;')}</Location>
    <PostalCode>${EBAY_SHIP_FROM_POSTAL_CODE}</PostalCode>
    <DispatchTimeMax>0</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Quantity>2</Quantity>
    ${params.pictureXml}
    <ShipToLocations>US</ShipToLocations>
    ${shippingDetailsXml}
    <ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
      <RefundOption>MoneyBack</RefundOption>
      <ReturnsWithinOption>Days_30</ReturnsWithinOption>
      <ShippingCostPaidByOption>Seller</ShippingCostPaidByOption>
    </ReturnPolicy>
    <ItemSpecifics>
      ${params.itemSpecificsXml}
    </ItemSpecifics>
  </Item>
</${rootTag}>`
}

// ── Route handler ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  const isCron = Boolean(cronSecret && authHeader === `Bearer ${cronSecret}`)

  const session = isCron ? null : await getServerSession(authOptions)
  if (!isCron && !session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  // Trial gating: allow connected sellers to list a few items before upgrading.
  // Default plan is "trial" unless a subscription row indicates otherwise.
  const body = await req.json()
  const effectiveUserId = isCron ? body?.userId : session!.user.id
  const effectiveAccountId = isCron ? body?.accountId : null

  if (!effectiveUserId) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  await ensureSubscriptionRow(effectiveUserId)
  const sub = await getUserPlan(effectiveUserId)
  const plan = sub?.plan || 'trial'
  const parsedTrialLimit = Number(process.env.TRIAL_LIST_LIMIT || '5')
  const trialLimit = Number.isFinite(parsedTrialLimit) && parsedTrialLimit > 0 ? Math.floor(parsedTrialLimit) : 5
  const trialApplies = plan === 'trial' && trialLimit > 0
  if (trialApplies) {
    const usage = await getTrialUsage(effectiveUserId)
    if (usage.listed >= trialLimit) {
      return apiError(`Trial limit reached. You can list ${trialLimit} items for free — upgrade to keep listing.`, {
        status: 402,
        code: 'TRIAL_LIMIT_REACHED',
        details: { trialLimit, listed: usage.listed },
      })
    }
  }

  const {
    asin,
    title,
    ebayPrice,
    amazonPrice,
    imageUrl,
    images,
    features,
    description: inputDescription,
    specs,
    niche,
    trusted,
    categoryId: providedCategoryId,
    // ignore cron-only fields
    userId: _userIdIgnored,
    accountId: _accountIdIgnored,
  } = body
  if (!asin || !title || ebayPrice === undefined || ebayPrice === null) {
    return apiError('ASIN, title, and eBay price are required.', { status: 400, code: 'INVALID_LISTING_INPUT' })
  }

  const parsedEbayPrice = Number(ebayPrice)
  if (!Number.isFinite(parsedEbayPrice) || parsedEbayPrice <= 0) {
    return apiError('Enter a valid eBay price before publishing.', { status: 400, code: 'INVALID_LISTING_PRICE' })
  }

  // Reject if this ASIN is already active anywhere on StackPilot. Product Finder
  // filters cross-user duplicates, but publish is the final gate for stale tabs,
  // direct API calls, and background listing paths.
  const existingListing = await queryRows<{ ebay_listing_id: string; is_mine: boolean }>`
    SELECT ebay_listing_id, (user_id = ${effectiveUserId}) AS is_mine
    FROM listed_asins
    WHERE asin = ${String(asin).toUpperCase()} AND ended_at IS NULL
    LIMIT 1
  `.catch(() => [])
  if (existingListing.length > 0) {
    const listingId = existingListing[0].ebay_listing_id
    const message = existingListing[0].is_mine
      ? `This product (ASIN ${asin}) is already listed on your eBay store (listing #${listingId}). Duplicate listings are blocked to protect your account.`
      : `This product (ASIN ${asin}) is already active on another StackPilot listing. Duplicate platform listings are blocked so sellers do not compete with the same Amazon source.`
    return apiError(
      message,
      { status: 409, code: 'ALREADY_LISTED' }
    )
  }

  const initialPolicyFlags = getListingPolicyFlags({ title, description: inputDescription, niche })
  if (hasBlockedListingPolicyFlag(initialPolicyFlags)) {
    return apiError(getListingPolicyBlockReason(initialPolicyFlags), {
      status: 400,
      code: 'LISTING_POLICY_BLOCKED',
      details: { flags: initialPolicyFlags },
    })
  }

  const credentials = await getValidEbayAccessToken(String(effectiveUserId), effectiveAccountId)
  if (!credentials?.accessToken) {
    return apiError('Your eBay session expired. Reconnect your account in Settings.', {
      status: 401,
      code: 'RECONNECT_REQUIRED',
    })
  }

  const appId = process.env.EBAY_APP_ID || ''

  const fallbackAmazonPrice = Number.isFinite(Number(amazonPrice)) ? Number(amazonPrice) : undefined
  const sourceAsin = String(asin).toUpperCase()
  const markSourceAsinRejected = async () => {
    await sql`
      UPDATE product_source_items
      SET active = FALSE,
          source_quality = 'reject',
          last_seen_at = NOW(),
          last_intelligence_at = NOW()
      WHERE asin = ${sourceAsin}
    `.catch(() => {})
  }

  let validatedAmazon: NonNullable<Awaited<ReturnType<typeof fetchAmazonProductByAsin>>>
  if (trusted && fallbackAmazonPrice && title && (imageUrl || (Array.isArray(images) && images.length > 0))) {
    // Fast-path: product came from finder queue and is already validated — skip Amazon re-fetch
    validatedAmazon = {
      asin,
      title,
      amazonPrice: fallbackAmazonPrice,
      imageUrl: imageUrl || (Array.isArray(images) ? images[0] : undefined),
      images: Array.isArray(images) ? images : imageUrl ? [imageUrl] : [],
      features: Array.isArray(features) ? features : [],
      description: typeof inputDescription === 'string' ? inputDescription : '',
      specs: Array.isArray(specs) ? specs : [],
      available: true,
      source: 'cache' as const,
    }
  } else {
    const fetched = await fetchAmazonProductByAsin({
      asin,
      fallbackImage: imageUrl,
      fallbackTitle: title,
      fallbackPrice: fallbackAmazonPrice,
      strictAsin: true,
    })
    if (!fetched) {
      return apiError('ASIN validation failed because the ASIN is invalid or could not be recovered.', {
        status: 400,
        code: 'ASIN_VALIDATION_FAILED',
      })
    }
    validatedAmazon = fetched

    // ASIN cross-mapping guard: if the live Amazon title is completely different from
    // the queued title, the ASIN has drifted to a different product. Block the listing
    // before it creates a keyboard-sold-as-eye-mask situation.
    if (validatedAmazon.source !== 'fallback' && title) {
      const queuedWords = new Set(
        String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2)
      )
      const validatedWords = new Set(
        validatedAmazon.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2)
      )
      let overlap = 0
      for (const word of queuedWords) { if (validatedWords.has(word)) overlap++ }
      const similarity = queuedWords.size > 0 ? overlap / queuedWords.size : 1
      // 0.42 threshold: strict enough to catch "keyboard" vs "eye mask" (0% overlap),
      // loose enough to allow for shortened/variant titles ("TKL Keyboard" vs "87-Key TKL Keyboard")
      if (similarity < 0.42) {
        await markSourceAsinRejected()
        return apiError(
          `ASIN ${asin} now maps to a different product on Amazon ("${validatedAmazon.title.slice(0, 60)}"). Remove this from your queue and reload for fresh products.`,
          { status: 400, code: 'ASIN_MISMATCH' }
        )
      }
    }
  }

  // Cache lookup: runs for ALL trusted listings + non-trusted sparse listings.
  // Trusted mode always checks the cache — we need to detect ASIN cross-mapping even when
  // the pool product has rich images (those images may be from the WRONG product).
  const isDataSparse =
    validatedAmazon.images.length < 3 ||
    !validatedAmazon.description ||
    validatedAmazon.features.length === 0

  if (isDataSparse || trusted) {
    try {
      const cached = await loadCachedAmazonProduct(asin)
      if (cached) {

        // ── ASIN cross-mapping guard (trusted mode) ──────────────────────────
        // Runs unconditionally for every trusted/bulk listing.
        // When an ASIN drifts to a completely different product (e.g. iPad → iPhone,
        // JETech → Uyiton), the pool title and cache title will have low word overlap.
        // This catches it before wrong-product images and a loss-making price go live.
        if (trusted && cached.title && title) {
          const toWords = (s: string) => new Set(
            s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2)
          )
          const poolWords = toWords(String(title))
          const cacheWords = toWords(cached.title)
          let overlap = 0
          for (const word of poolWords) { if (cacheWords.has(word)) overlap++ }
          const similarity = poolWords.size > 0 ? overlap / poolWords.size : 1
          if (similarity < 0.42) {
            await markSourceAsinRejected()
            return apiError(
              `ASIN ${asin} now maps to a different product ("${cached.title.slice(0, 60)}"). Queue entry is stale — remove it and reload for fresh products.`,
              { status: 400, code: 'ASIN_MISMATCH' }
            )
          }
        }

        // ── Title accuracy: use cache title in trusted mode ──────────────────
        // Pool titles come from scrapeAmazonSearch which can return stale/wrong titles.
        // The amazon_product_cache has the most recently verified Amazon title for this ASIN.
        // Since we've already passed the mismatch check (>= 0.45 similarity), the cache
        // title is the same product — use it as it's more accurate and up-to-date.
        if (trusted && cached.title && cached.title.length > 10) {
          validatedAmazon = { ...validatedAmazon, title: cached.title }
        }

        // ── Price accuracy: use cache price in trusted mode if significantly newer ─
        // If the cache has a price that differs by >10% from the pool price, use it.
        // The cache is populated by live Amazon API/scrape calls during finder runs,
        // so it reflects the current Amazon price more accurately than the pool.
        if (trusted && cached.amazonPrice > 0) {
          const priceDrift = Math.abs(cached.amazonPrice - validatedAmazon.amazonPrice) / Math.max(validatedAmazon.amazonPrice, 1)
          if (priceDrift > 0.10) {
            validatedAmazon = { ...validatedAmazon, amazonPrice: cached.amazonPrice }
          }
        }

        // ── Sparse data supplement ───────────────────────────────────────────
        if (isDataSparse) {
          if (cached.images.length > validatedAmazon.images.length) {
            validatedAmazon = { ...validatedAmazon, images: cached.images, imageUrl: cached.imageUrl || validatedAmazon.imageUrl }
          }
          if (!validatedAmazon.description && cached.description) {
            validatedAmazon = { ...validatedAmazon, description: cached.description }
          }
          if (validatedAmazon.features.length === 0 && cached.features.length > 0) {
            validatedAmazon = { ...validatedAmazon, features: cached.features }
          }
          if (validatedAmazon.specs.length === 0 && cached.specs.length > 0) {
            validatedAmazon = { ...validatedAmazon, specs: cached.specs }
          }
        }

        // Availability: if cache confirms out-of-stock, trust it even if it still has an old price.
        if (!cached.available) {
          validatedAmazon = { ...validatedAmazon, available: false }
        }

        // Persist the merged result so future lookups hit the cache
        saveCachedAmazonProduct(validatedAmazon).catch(() => {})
      }
    } catch { /* cache lookup is best-effort — never block on failure */ }
  }

  // Trusted mode (bulk List All): the product came from the source pool, which is
  // already validated by the 30-min cron (availability checks, price refresh, etc.).
  // The cache lookup above already confirmed ASIN title match, pulled the latest price,
  // and marked validatedAmazon.available = false if cache confirms out-of-stock.
  // Scraping Amazon live for every product in a 30-item bulk run triggers rate-limiting
  // (api-services-support page) which causes CHECK_FAILED for every item in the batch.
  // Non-trusted (single listing from the modal) still gets a live scrape — it's one call.
  let liveAvailability: Awaited<ReturnType<typeof checkAmazonLiveAvailability>>

  if (trusted) {
    // Use the already-validated cache/pool data as the availability result
    if (!validatedAmazon.available) {
      liveAvailability = {
        ok: false,
        asin,
        reason: 'UNAVAILABLE' as const,
        title: validatedAmazon.title,
        amazonPrice: validatedAmazon.amazonPrice,
        imageUrl: validatedAmazon.imageUrl,
        images: validatedAmazon.images,
        checkedAt: new Date().toISOString(),
      }
    } else {
      liveAvailability = {
        ok: true,
        asin,
        title: validatedAmazon.title,
        amazonPrice: validatedAmazon.amazonPrice,
        imageUrl: validatedAmazon.imageUrl,
        images: validatedAmazon.images,
        checkedAt: new Date().toISOString(),
      }
    }
  } else {
    liveAvailability = await checkAmazonLiveAvailability(asin, {
      fallbackTitle: validatedAmazon.title || title,
      fallbackImage: validatedAmazon.imageUrl || imageUrl,
    })
  }

  if (!liveAvailability.ok) {
    const confirmedUnavailable = liveAvailability.reason !== 'CHECK_FAILED'
    if (confirmedUnavailable) {
      await markSourceAsinRejected()
    }

    return apiError(
      liveAvailability.reason === 'CHECK_FAILED'
        ? 'Could not verify this product is currently buyable on Amazon. Remove it from your queue and reload to get a fresh product.'
        : 'This product is currently unavailable on Amazon and cannot be listed. Remove it from your queue and reload to get fresh products.',
      {
        status: 400,
        code: liveAvailability.reason === 'CHECK_FAILED' ? 'AMAZON_LIVE_CHECK_FAILED' : 'PRODUCT_UNAVAILABLE',
        details: { asin, reason: liveAvailability.reason },
      }
    )
  }

  if (title) {
    const toWords = (value: string) => new Set(
      value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((word) => word.length > 2)
    )
    const queuedWords = toWords(String(title))
    const liveWords = toWords(liveAvailability.title)
    let overlap = 0
    for (const word of queuedWords) { if (liveWords.has(word)) overlap++ }
    const similarity = queuedWords.size > 0 ? overlap / queuedWords.size : 1
    if (similarity < 0.42) {
      await markSourceAsinRejected()
      return apiError(
        `ASIN ${asin} now maps to a different product on Amazon ("${liveAvailability.title.slice(0, 60)}"). Remove it from your queue and reload for fresh products.`,
        { status: 400, code: 'ASIN_MISMATCH' }
      )
    }
  }

  const liveImages = Array.from(new Set([
    ...liveAvailability.images,
    ...validatedAmazon.images,
    validatedAmazon.imageUrl || '',
  ].filter((url) => url.startsWith('http'))))

  validatedAmazon = {
    ...validatedAmazon,
    title: liveAvailability.title || validatedAmazon.title,
    amazonPrice: liveAvailability.amazonPrice,
    imageUrl: liveAvailability.imageUrl || liveImages[0] || validatedAmazon.imageUrl,
    images: liveImages.length > 0 ? liveImages : validatedAmazon.images,
    available: true,
    source: 'scrape',
  }

  // Block listings where Amazon shows the product as unavailable (out of stock, no price).
  // Applies to both live-validated (non-trusted) and cache-supplemented (trusted) paths.
  if (!validatedAmazon.available) {
    await markSourceAsinRejected()
    saveCachedAmazonProduct({ ...validatedAmazon, available: false }).catch(() => {})

    return apiError(
      `This product is currently unavailable on Amazon and cannot be listed. Remove it from your queue and reload to get fresh products.`,
      { status: 400, code: 'PRODUCT_UNAVAILABLE' }
    )
  }

  // In non-trusted mode: after all supplementation, if we still only have fallback-quality
  // data (1 image, no features), block the listing. This prevents publishing a listing with
  // the wrong product photo and empty description — which is worse than not listing at all.
  if (!trusted && validatedAmazon.source === 'fallback' && validatedAmazon.images.length <= 1) {
    return apiError(
      `Cannot validate this product on Amazon — the ASIN may be stale or Amazon is temporarily unavailable. Remove it from your queue and reload to get fresh products.`,
      { status: 400, code: 'ASIN_VALIDATION_FAILED' }
    )
  }

  const listingTitle = chooseBestListingTitle([validatedAmazon.title, title]) || title
  const listingAmazonPrice = validatedAmazon.amazonPrice

  const cleanTitle = listingTitle
    // Decode HTML entities first so &quot; → " then gets stripped cleanly
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&lt;|&#60;/gi, '<')
    .replace(/&gt;|&#62;/gi, '>')
    // Strip Amazon-specific badges and labels that must never appear on eBay
    .replace(/\[?\b(amazon[''']?s?\s+choice|overall\s+pick|#?\s*1\s+best\s+seller|best\s+seller|limited\s+time\s+deal|climate\s+pledge\s+friendly|small\s+business|sponsored|top\s+brand|highly\s+rated|deal\s+of\s+the\s+day)\b\]?/gi, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>"]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/\s*[-|,]\s*(Pack of|Pack|Count|Piece|Pcs|Units?|Set of)\s*\d+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const rawSafeTitle = (() => {
    if (cleanTitle.length <= 80) return cleanTitle
    // Remove last partial word after slicing to 80 chars
    let t = cleanTitle.slice(0, 80).replace(/\s+\S*$/, '').trim()
    // Strip trailing prepositions/connectors that leave a dangling incomplete phrase
    // e.g. "...Sleep Mask with Zero" → "...Sleep Mask"
    t = t.replace(/\s+(?:with|for|in|to|of|and|or|a|an|the|by|at|from|as|into|zero|one|two|three|four|five|&|\+)$/i, '').trim()
    // Strip trailing punctuation left over from comma-separated Amazon titles
    // e.g. "...with 18 Backlight Modes," → "...with 18 Backlight Modes"
    t = t.replace(/[\s,;:\-|]+$/, '').trim()
    return t
  })()

  // ── SEO Title Expander ───────────────────────────────────────────────────────
  // eBay's Cassini algorithm ranks by keyword match. Fill the 80-char budget
  // with the highest-value search terms buyers actually type.
  const SEO_KEYWORDS: Record<string, string[]> = {
    'Phone Accessories':      ['Cell Phone', 'Universal Fit', 'Compatible', 'Protective', 'Wireless'],
    'Computer Parts':         ['Laptop', 'Desktop', 'MacBook', 'USB', 'PC', 'Compatible', 'Ergonomic'],
    'Audio & Headphones':     ['Wireless', 'Bluetooth', 'Noise Cancelling', 'Over Ear', 'Earbuds', 'Hi-Fi'],
    'Smart Home Devices':     ['WiFi', 'Alexa', 'Google Home', 'Smart', 'Voice Control', 'App Control'],
    'Gaming Gear':            ['PS5', 'Xbox', 'PC', 'Gaming', 'Controller', 'RGB', 'Mechanical'],
    'Kitchen Gadgets':        ['Kitchen', 'Cooking', 'Baking', 'BPA Free', 'Dishwasher Safe', 'Non-Stick'],
    'Home Decor':             ['Modern', 'Wall Decor', 'Living Room', 'Bedroom', 'Aesthetic', 'Gift'],
    'Furniture & Lighting':   ['Adjustable', 'LED', 'Desk', 'Home Office', 'Energy Efficient', 'Dimmable'],
    'Cleaning Supplies':      ['Heavy Duty', 'Reusable', 'Washable', 'All Surface', 'Commercial Grade'],
    'Storage & Organization': ['Organizer', 'Space Saving', 'Stackable', 'Clear', 'Drawer', 'Cabinet'],
    'Camping & Hiking':       ['Outdoor', 'Waterproof', 'Lightweight', 'Portable', 'Survival', 'Camping'],
    'Garden & Tools':         ['Heavy Duty', 'Garden', 'Outdoor', 'Stainless Steel', 'Ergonomic Grip'],
    'Sporting Goods':         ['Athletic', 'Training', 'Gym', 'Outdoor', 'Performance', 'All Season'],
    'Fishing & Hunting':      ['Fishing', 'Hunting', 'Outdoor', 'Heavy Duty', 'All Season', 'Waterproof'],
    'Fitness Equipment':      ['Home Gym', 'Workout', 'Exercise', 'Training', 'Resistance', 'Adjustable'],
    'Personal Care':          ['Portable', 'Rechargeable', 'Professional', 'Salon Quality', 'Travel Size'],
    'Medical Supplies':       ['FDA Approved', 'Medical Grade', 'Professional', 'Accurate', 'Digital'],
    'Car Accessories':        ['Universal Fit', 'All Cars', 'SUV', 'Truck', 'Interior', 'Auto Accessory'],
    'Car Parts':              ['Universal', 'OEM Quality', 'Heavy Duty', 'All Cars', 'Direct Fit'],
    'Pet Supplies':           ['Dog', 'Cat', 'Small Medium Large', 'Safe', 'Durable', 'Easy Clean'],
    'Baby & Kids':            ['BPA Free', 'Non-Toxic', 'Safe', 'Toddler', 'Newborn', 'Gender Neutral'],
    'Toys & Games':           ['Educational', 'Ages 3+', 'STEM', 'Interactive', 'Battery Operated'],
    'Clothing & Accessories': ['Unisex', 'One Size', 'Adjustable', 'Lightweight', 'Casual', 'Gift'],
    'Jewelry & Watches':      ['Fashion', 'Stainless Steel', 'Hypoallergenic', 'Gift Box', 'Elegant'],
    'Office Supplies':        ['Desk Organizer', 'Home Office', 'Work From Home', 'Heavy Duty', 'Professional'],
    'Trading Cards':          ['Acid Free', 'Card Sleeves', 'Binder', 'Collector', 'Protective'],
    'Coins & Currency':       ['Collector', 'Display Case', 'Protective', 'Storage', 'Archival Quality'],
    'Sports Memorabilia':     ['Display Case', 'Frame', 'Collectible', 'Authentic', 'UV Protected'],
  }

  function buildSeoTitle(base: string, productNiche: string | null, productSpecs: Array<[string, string]>): string {
    const budget = 80 - base.length
    if (budget <= 3) return base

    const baseLower = base.toLowerCase()
    const candidates = SEO_KEYWORDS[productNiche || ''] || []

    // Also pull high-value spec values not already in title
    const specValues = productSpecs
      .filter(([k]) => /brand|model|compatible|size|material|connectivity/i.test(k))
      .map(([, v]) => sanitizeContent(v).split(/[,/]/)[0].trim())
      .filter(v => v.length > 2 && v.length < 20 && !baseLower.includes(v.toLowerCase()))

    const allCandidates = [...specValues, ...candidates]
    const additions: string[] = []
    let remaining = budget

    for (const term of allCandidates) {
      if (baseLower.includes(term.toLowerCase())) continue
      const needed = term.length + 1 // space + term
      if (remaining - needed < 0) continue
      additions.push(term)
      remaining -= needed
      if (remaining <= 3) break
    }

    if (additions.length === 0) return base
    return (base + ' ' + additions.join(' ')).slice(0, 80).replace(/\s+\S*$/, '').trim()
  }

  // Pass validatedAmazon.specs so buildSeoTitle can pull brand, model,
  // compatibility, and size values into the title — filling the 80-char
  // eBay budget with real product attributes buyers actually search for.
  const safeTitle = buildSeoTitle(rawSafeTitle, niche, validatedAmazon.specs || [])

  if (isWeakListingTitle(safeTitle)) {
    return apiError(
      `"${safeTitle}" is a brand-only or unrecognizable title — it would make a poor eBay listing. Edit the title before publishing, or try a different ASIN.`,
      { status: 400, code: 'WEAK_LISTING_TITLE' }
    )
  }

  const nicheCategoryId = NICHE_CATEGORY[niche] || '177'

  // Trusted/bulk mode: skip competitor lookup — use provided price directly (already priced by the engine)
  const comparableMarket = trusted
    ? { prices: [], count: 0 }
    : await getComparableEbayPrices(safeTitle, credentials.accessToken, listingAmazonPrice)

  const baseAutoPrice = getRecommendedEbayPrice(listingAmazonPrice, EBAY_DEFAULT_FEE_RATE)
  const pricingRecommendation = getPricingRecommendation({
    amazonPrice: listingAmazonPrice,
    feeRate: EBAY_DEFAULT_FEE_RATE,
    competitorPrices: comparableMarket.prices,
    competitorCount: comparableMarket.count,
  })
  const priceLooksAutomatic =
    Math.abs(parsedEbayPrice - baseAutoPrice) <= Math.max(0.06, baseAutoPrice * 0.01) ||
    Math.abs(parsedEbayPrice - pricingRecommendation.targetPrice) <= Math.max(0.06, pricingRecommendation.targetPrice * 0.01) ||
    Math.abs(parsedEbayPrice - pricingRecommendation.price) <= Math.max(0.06, pricingRecommendation.price * 0.01)

  const pricingWarning = !pricingRecommendation.viable && pricingRecommendation.confidence === 'high'
    ? 'Comparable eBay prices are below the minimum profitable price, so StackPilot used the minimum profitable price instead of blocking the listing.'
    : null

  // Trusted (bulk) mode: always recalculate from the current pricing engine — the cached
  // ebayPrice may have been built with old pricing logic or a stale Amazon cost.
  // Non-trusted (single): respect manual price edits if the user changed it from the auto-price.
  let finalEbayPrice = trusted
    ? pricingRecommendation.price
    : priceLooksAutomatic
      ? pricingRecommendation.price
      : Math.max(parsedEbayPrice, pricingRecommendation.minimumViablePrice)

  // Market sanity check — runs for ALL trusted listings above $18 (covers most products).
  // Two failure modes this catches:
  //   1. OVERPRICED: cached Amazon cost too HIGH → our price inflated vs market → cap it down
  //   2. UNDERPRICED: cached Amazon cost too LOW → our price below market → block it
  //      (e.g. Amazon lock cached at $25, actual $52.96, we list at $36.99 = $21 loss per sale)
  if (trusted && finalEbayPrice > 18) {
    try {
      const marketCheck = await getComparableEbayPrices(safeTitle, credentials.accessToken, listingAmazonPrice)
      if (marketCheck.count >= 3) {
        const sorted = [...marketCheck.prices].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]
        if (median > 0) {
          if (finalEbayPrice > median * 1.4) {
            // Too expensive vs market — cap to market level
            finalEbayPrice = Number(Math.max(pricingRecommendation.minimumViablePrice, median * 1.1).toFixed(2))
          } else if (finalEbayPrice < median * 0.62) {
            // Our price is 38%+ below what every competitor charges — cached Amazon cost is
            // almost certainly stale or wrong. Listing at this price means buying at a loss.
            return apiError(
              `Blocked — your listing price ($${finalEbayPrice.toFixed(2)}) is well below similar eBay listings (~$${median.toFixed(2)}). The Amazon cost in your queue is likely outdated. Remove this product and reload your queue to get a fresh price.`,
              { status: 400, code: 'PRICE_BELOW_MARKET' }
            )
          }
        }
      }
    } catch { /* market check is best-effort — never block a listing on lookup failure */ }
  }

  // Hard backstop — catches stale cache where Amazon raised their price after queuing
  const priceCheck = getListingMetrics(listingAmazonPrice, finalEbayPrice, EBAY_DEFAULT_FEE_RATE)
  if (priceCheck.profit < 1) {
    return apiError(
      `Cannot list — the eBay price ($${finalEbayPrice.toFixed(2)}) is below the Amazon cost ($${listingAmazonPrice.toFixed(2)}) after fees. Amazon likely raised their price since this product was queued. It will be repriced automatically on the next refresh cycle.`,
      { status: 400, code: 'UNPROFITABLE_LISTING' }
    )
  }

  // Sanity check — if the eBay price is over 4x the minimum viable price, the cached
  // Amazon cost was likely wrong (stale ASIN cross-mapping). Recalculate from scratch.
  const minViable = pricingRecommendation.minimumViablePrice
  if (minViable > 0 && finalEbayPrice > minViable * 4) {
    return apiError(
      `The listed price ($${finalEbayPrice.toFixed(2)}) looks too high for this product — the Amazon cost may be stale or from the wrong product. Remove it from your queue and re-source it.`,
      { status: 400, code: 'PRICE_SANITY_FAILED' }
    )
  }

  const price = finalEbayPrice.toFixed(2)
  const fallbackSpecificsXml = (NICHE_SPECIFICS[niche] || [])
    .map(([n, v]) => `\n      <NameValueList><Name>${n}</Name><Value>${v}</Value></NameValueList>`)
    .join('')

  const rapidKey = getRapidApiKey()
  // In trusted mode (List All), skip the live Amazon fetch entirely — it can pull
  // images and features from other products in the same brand catalog, contaminating
  // the gallery with wrong product photos.
  const fetchedAmazon = trusted
    ? { images: [] as string[], features: [] as string[], description: '', specs: [] as Array<[string, string]>, _apiError: undefined }
    : await fetchAmazonDetails(asin, rapidKey, validatedAmazon.imageUrl)
  const validatedRich = hasRichAmazonContent(validatedAmazon)
  const fetchedRich = hasRichAmazonContent(fetchedAmazon)
  const preferredFeatureSources = [
    ...validatedAmazon.features,
    ...(validatedRich ? [] : fetchedAmazon.features),
  ]
  const amazon = {
    images: dedupeImageUrls([
      ...validatedAmazon.images,
      validatedAmazon.imageUrl,
      imageUrl,
    ]),
    features: Array.from(
      new Set(
        preferredFeatureSources
          .map((value) => sanitizeContent(String(value || '')))
          .filter((value) => value.length > 6)
          .filter((value) => (validatedRich ? !isGenericFeature(value) : true))
      )
    ).slice(0, 10),
    description: (() => {
      const d = sanitizeDescriptionText(chooseBestDescription(
        validatedAmazon.description,
        fetchedAmazon.description,
      ))
      if (d) return d
      // Fallback: synthesise a description from features so the listing is never
      // product-detail-empty. buildOriginalFeatureBullets covers it in the HTML,
      // but having description text improves eBay search indexing too.
      const featureFallback = (validatedAmazon.features.length > 0 ? validatedAmazon.features : preferredFeatureSources)
        .slice(0, 5)
        .map(f => sanitizeContent(String(f || '')))
        .filter(f => f.length > 10)
        .join(' ')
      return featureFallback || ''
    })(),
    specs: [
      ...validatedAmazon.specs,
      ...(validatedRich ? [] : fetchedAmazon.specs),
      ...(fetchedRich ? fetchedAmazon.specs : []),
    ].filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length >= 2)
      .map(([key, value]) => [sanitizeContent(key), sanitizeContent(value)] as [string, string])
      .filter(([key, value]) => key.length > 1 && value.length > 1)
      .slice(0, 16),
    _apiError: fetchedAmazon._apiError,
  }
  amazon.specs = dedupeSpecEntries(amazon.specs)
  // Include a spec value summary so brand names or restricted terms inside
  // product specs (e.g. "Compatible: Nike", "Brand: Apple") are also caught.
  const specText = (amazon.specs || []).map(([k, v]) => `${k}: ${v}`).join(' ')
  const validatedPolicyFlags = getListingPolicyFlags({
    title: listingTitle,
    description: amazon.description ? `${amazon.description} ${specText}` : specText,
    niche,
  })
  if (hasBlockedListingPolicyFlag(validatedPolicyFlags)) {
    return apiError(getListingPolicyBlockReason(validatedPolicyFlags), {
      status: 400,
      code: 'LISTING_POLICY_BLOCKED',
      details: { flags: validatedPolicyFlags },
    })
  }

  const itemSpecificsXml = buildItemSpecificsXml(listingTitle, amazon.specs, fallbackSpecificsXml, niche)

  const host = req.headers.get('host') || ''
  const proto = host.startsWith('localhost') ? 'http' : 'https'
  const siteUrl = `${proto}://${host}`

  // Never use fetchedAmazon.images — it pulls from Amazon's related products carousel
  // and contaminates the gallery with images from completely different products.
  // Only use images that are directly tied to this specific ASIN.
  const validatedGallery = dedupeImageUrls([
    ...validatedAmazon.images,
    validatedAmazon.imageUrl,
    imageUrl,
  ])
  const allImages = filterVariantSpecificImages(
    validatedGallery.length > 0
      ? validatedGallery
      : dedupeImageUrls([validatedAmazon.imageUrl, imageUrl]),
    listingTitle,
    amazon.specs
  )

  const filteredImages = dedupeImageUrls(allImages)
    .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
    .slice(0, 6)

  if (filteredImages.length < MIN_LISTING_IMAGES) {
    return apiError(
      `Only ${filteredImages.length} usable product image${filteredImages.length === 1 ? '' : 's'} could be found for this ASIN. StackPilot requires at least ${MIN_LISTING_IMAGES} real product photos before publishing, so reload the queue or choose a different product.`,
      { status: 400, code: filteredImages.length === 0 ? 'NO_LISTING_IMAGES' : 'INSUFFICIENT_LISTING_IMAGES' }
    )
  }

  // Image quality tracking: flag listings that ship with only 1 image.
  // These still go through — we do not block them — but they are marked
  // so the admin can measure the scale of the problem and prioritize
  // background enrichment for the affected ASINs.
  const imageQualityWarning = filteredImages.length < 2

  const fallbackListingImage = `${siteUrl}/api/image/fallback?asin=${encodeURIComponent(asin)}&title=${encodeURIComponent(listingTitle)}`
  const primarySourceImage = filteredImages[0] || validatedAmazon.imageUrl || fallbackListingImage
  const primaryProxyImage = primarySourceImage.includes('/api/image/')
    ? primarySourceImage
    : `${siteUrl}/api/image/proxy?url=${encodeURIComponent(primarySourceImage)}`
  const badgeUrl = `${siteUrl}/api/image/badge?url=${encodeURIComponent(primaryProxyImage)}&asin=${encodeURIComponent(asin)}&title=${encodeURIComponent(listingTitle)}`
  const cleanDescriptionPrimary = primarySourceImage.includes('/api/image/')
    ? primarySourceImage
    : `${siteUrl}/api/image/proxy?url=${encodeURIComponent(primarySourceImage)}`
  const cleanGalleryUrls = filteredImages.slice(1).map((u) => `${siteUrl}/api/image/proxy?url=${encodeURIComponent(u)}`)
  const descriptionImageUrls = [
    cleanDescriptionPrimary,
    ...cleanGalleryUrls.slice(0, 5),
  ]

  const epsSourceUrls =
    filteredImages.length > 0
      ? [badgeUrl, ...cleanGalleryUrls]
      : [badgeUrl]
  const pictureList = await Promise.all(
    epsSourceUrls.map((u) => uploadToEPS(u, credentials.accessToken, appId))
  )

  const usablePictureList = dedupeImageUrls(
    pictureList.filter((u): u is string => Boolean(u) && u.length <= 500)
  )
  if (usablePictureList.length === 0) {
    // EPS upload failed — fall back to badge URL first (keeps the FREE SHIPPING stamp),
    // then remaining images without the stamp
    usablePictureList.push(
      badgeUrl,
      ...filteredImages.slice(1).filter((u) => u.length <= 500).slice(0, 5)
    )
  }
  if (usablePictureList.length < MIN_LISTING_IMAGES) {
    for (const fallbackUrl of [badgeUrl, ...filteredImages.slice(1)]) {
      if (usablePictureList.length >= MIN_LISTING_IMAGES) break
      if (fallbackUrl.length > 500 || usablePictureList.includes(fallbackUrl)) continue
      usablePictureList.push(fallbackUrl)
    }
  }
  // eBay constraint: total length of all Picture URLs (including XML overhead) must
  // stay under 3,975 chars. Each `&` becomes `&amp;` in the XML payload, so allow
  // an ~8% margin under the cap to be safe.
  const EBAY_PICTURE_URL_TOTAL_LIMIT = 3700
  const cappedPictureList: string[] = []
  let totalPictureUrlLength = 0
  for (const url of usablePictureList) {
    if (url.length > 500) continue
    const xmlPaddedLength = url.length + (url.match(/&/g)?.length || 0) * 4 // &→&amp;
    if (totalPictureUrlLength + xmlPaddedLength > EBAY_PICTURE_URL_TOTAL_LIMIT) break
    cappedPictureList.push(url)
    totalPictureUrlLength += xmlPaddedLength
  }
  // Replace usablePictureList with the capped slice so downstream XML stays under the limit.
  usablePictureList.length = 0
  usablePictureList.push(...cappedPictureList)
  if (usablePictureList.length < MIN_LISTING_IMAGES) {
    return apiError(
      `This product only produced ${usablePictureList.length} publishable image${usablePictureList.length === 1 ? '' : 's'} after eBay image processing. StackPilot requires at least ${MIN_LISTING_IMAGES} photos, so reload the queue or choose a different product.`,
      { status: 400, code: 'INSUFFICIENT_LISTING_IMAGES' }
    )
  }

  const description = buildDescription(
    safeTitle,
    amazon.features,
    amazon.description,
    descriptionImageUrls,
    amazon.specs,
    niche
  )


  const xmlEncodeUrl = (u: string) => u.replace(/&/g, '&amp;').replace(/</g, '').replace(/>/g, '')
  const pictureXml = usablePictureList.length > 0
    ? `<PictureDetails><GalleryType>Gallery</GalleryType>${usablePictureList.map(u => `<PictureURL>${xmlEncodeUrl(u)}</PictureURL>`).join('')}</PictureDetails>`
    : ''

  // If a pre-computed categoryId was passed (bulk mode), skip all API lookups
  const cleanAsin = String(asin).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
  const titleQuery = safeTitle.split(' ').slice(0, 6).join(' ')
  const [asinCategory, comparableCategory, taxonomyIds, legacySuggestions] = providedCategoryId
    ? [providedCategoryId, null, [providedCategoryId], []]
    : await Promise.all([
        getCategoryByAsin(cleanAsin, credentials.accessToken),
        getCategoryByComparableListings(safeTitle, credentials.accessToken),
        getTaxonomyCategoryIds(safeTitle, credentials.accessToken),
        getSuggestedCategoryIds(titleQuery, appId, credentials.accessToken),
      ])

  // Last-resort fallback still tries to land in a real leaf category instead of eBay's generic bucket.
  const titleFallback = inferFallbackCategoryFromTitle(safeTitle, niche)
  const nicheFallback = NICHE_FALLBACK_LEAF_CATEGORY[niche || ''] || titleFallback || nicheCategoryId || DEFAULT_LEAF_CATEGORY

  const categorySourceById = new Map<string, string[]>()
  const addCategorySource = (categoryId: string | null | undefined, source: string) => {
    if (!categoryId) return
    categorySourceById.set(categoryId, Array.from(new Set([...(categorySourceById.get(categoryId) || []), source])))
  }
  addCategorySource(asinCategory, 'asin-browse')
  addCategorySource(comparableCategory, 'comparable-listings')
  taxonomyIds.forEach((categoryId) => addCategorySource(categoryId, 'taxonomy'))
  legacySuggestions.forEach((categoryId) => addCategorySource(categoryId, 'legacy-suggested'))
  addCategorySource(titleFallback, 'title-fallback')
  addCategorySource(nicheFallback, 'niche-fallback')
  addCategorySource(nicheCategoryId, 'niche-default')
  addCategorySource(DEFAULT_LEAF_CATEGORY, 'default-leaf-fallback')

  // Priority: real listing signals -> semantic Taxonomy -> legacy keyword -> niche/title fallback.
  const categoryCandidateIds = [
    asinCategory,
    comparableCategory,
    ...taxonomyIds,
    ...legacySuggestions,
    titleFallback,
    nicheFallback,
    nicheCategoryId,
    DEFAULT_LEAF_CATEGORY,
  ]
  const categoryCandidates = Array.from(new Set(categoryCandidateIds.filter(Boolean) as string[]))
  const preferredCategoryId = categoryCandidates[0] || DEFAULT_LEAF_CATEGORY
  const leafSuggestedCategoryIds = Array.from(new Set([asinCategory, comparableCategory, ...taxonomyIds, ...legacySuggestions].filter(Boolean) as string[])).slice(0, 8)
  const xmlParams = { token: credentials.accessToken, safeTitle, description, categoryId: preferredCategoryId, price, pictureXml, itemSpecificsXml, sourceAsin: String(asin).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) }

  // Parse eBay response — skip deprecated warnings to surface real errors
  const notWarn = (s: string) => {
    const l = s.toLowerCase()
    return !l.includes('deprecated') && !l.includes('condition is not applicable') && !l.includes('condition value submitted has been dropped')
  }
  const parse = (r: string) => {
    const shorts = [...r.matchAll(/<ShortMessage>(.*?)<\/ShortMessage>/g)].map(m => m[1])
    const longs  = [...r.matchAll(/<LongMessage>(.*?)<\/LongMessage>/g)].map(m => m[1])
    const codes  = [...r.matchAll(/<ErrorCode>(.*?)<\/ErrorCode>/g)].map(m => m[1])
    return {
      short: shorts.find(notWarn) || shorts[0] || '',
      long:  longs.find(notWarn)  || longs[0]  || '',
      codes,
      longs,
    }
  }

  const extractReplacementCategoryId = (r: string) => {
    const messages = [
      ...[...r.matchAll(/<LongMessage>(.*?)<\/LongMessage>/g)].map((match) => match[1]),
      ...[...r.matchAll(/<ShortMessage>(.*?)<\/ShortMessage>/g)].map((match) => match[1]),
    ]

    for (const message of messages) {
      const direct = message.match(/old category\s+\d+\s+replaced with new category\s+(\d+)/i)
      if (direct?.[1]) return direct[1]

      const generic = message.match(/replaced with new category\s+(\d+)/i)
      if (generic?.[1]) return generic[1]
    }

    return null
  }

  // Classify the dominant error type
  const errType = (short: string, long: string, codes: string[]) => {
    const t = (short + ' ' + long).toLowerCase()
    if (codes.includes('87') || t.includes('not a leaf') || t.includes('leaf category')) return 'leaf'
    if (t.includes('not valid') && t.includes('category')) return 'leaf'
    if (codes.includes('21919303') || (t.includes('item specific') && (t.includes('missing') || t.includes('required')))) return 'specific'
    return 'other'
  }

  const isTransientSystemError = (short: string, long: string, codes: string[]) => {
    const text = `${short} ${long}`.toLowerCase()
    return (
      codes.includes('10007') ||
      text.includes('system error') ||
      text.includes('unable to process your request') ||
      text.includes('please try again later')
    )
  }

  const extractUnavailableShippingService = (short: string, long: string) => {
    const text = `${short} ${long}`
    const match = text.match(/shipping service\s+(.+?)\s+is not available/i)
    return match?.[1]?.trim() || null
  }

  const hasInvalidShippingDetails = (short: string, long: string) => {
    const text = `${short} ${long}`.toLowerCase()
    return (
      text.includes('item.shippingdetails') ||
      text.includes('shippingdetails') ||
      text.includes('shipping service options')
    )
  }

  // Extract every "item specific X is missing" from eBay's error response and build XML for them
  const inferredBrandValue = inferBrandFromProduct(listingTitle, amazon.specs) || 'Generic'
  const inferredTypeValue = inferTypeFromProduct(listingTitle, niche, amazon.specs)

  const autoSpecificsXml = (r: string): string => {
    const longs = [...r.matchAll(/<LongMessage>(.*?)<\/LongMessage>/g)].map(m => m[1])
    const seen = new Set<string>()
    return longs.flatMap(l => {
      const m = l.match(/item specific (.+?) is missing/i)
      if (!m) return []
      const name = m[1].trim()
      if (seen.has(name)) return []
      seen.add(name)
      // Use sensible defaults for common required fields
      const defaults: Record<string, string> = {
        'Type': inferredTypeValue, 'Model': 'See Description', 'Color': 'See Description',
        'Connectivity': 'See Description', 'Compatible Brand': 'Universal',
        'Screen Size': 'See Description', 'Processor': 'See Description',
        'Storage Capacity': 'See Description', 'Operating System': 'See Description',
        'Sport': 'See Description', 'Department': 'Unisex Adults', 'Size': 'One Size',
        'Material': 'See Description', 'Style': 'See Description', 'Brand': inferredBrandValue,
      }
      const normalizedName = name.toLowerCase()
      const val =
        defaults[name]
        ?? (normalizedName.includes('brand') ? inferredBrandValue : null)
        ?? (normalizedName.includes('type') ? inferredTypeValue : null)
        ?? (normalizedName.includes('department') ? 'Unisex Adults' : null)
        ?? (normalizedName.includes('size') ? 'One Size' : null)
        ?? (normalizedName.includes('material') ? 'See Description' : null)
        ?? 'See Description'
      return [`\n      <NameValueList><Name>${name}</Name><Value>${val}</Value></NameValueList>`]
    }).join('')
  }

  const verifyCategoryCandidate = async (params: typeof xmlParams & { itemSpecificsXml: string }) => {
    let activeCategoryId = params.categoryId
    let workingSpecificsXml = params.itemSpecificsXml
    let responseText = ''
    let parsed = { short: '', long: '', codes: [] as string[], longs: [] as string[] }
    let errorKind: 'leaf' | 'specific' | 'other' = 'other'
    const attemptedCategoryIds: string[] = []
    let transientRetryUsed = false

    for (let guard = 0; guard < 6; guard += 1) {
      attemptedCategoryIds.push(activeCategoryId)
      responseText = await verifyToEbay(buildXml({ ...params, categoryId: activeCategoryId, itemSpecificsXml: workingSpecificsXml, requestType: 'verify' }), appId, credentials.accessToken)
      parsed = parse(responseText)
      errorKind = errType(parsed.short, parsed.long, parsed.codes)
      const verifyAck = responseText.match(/<Ack>(.*?)<\/Ack>/)?.[1] || ''

      if (verifyAck && verifyAck !== 'Failure' && errorKind !== 'leaf' && errorKind !== 'specific') {
        return {
          ok: true,
          categoryId: activeCategoryId,
          itemSpecificsXml: workingSpecificsXml,
          responseText,
          parsed,
          attemptedCategoryIds,
        }
      }

      const replacementCategoryId = extractReplacementCategoryId(responseText)
      if (replacementCategoryId && replacementCategoryId !== activeCategoryId && !attemptedCategoryIds.includes(replacementCategoryId)) {
        activeCategoryId = replacementCategoryId
        continue
      }

      if (errorKind === 'specific') {
        const auto = autoSpecificsXml(responseText)
        if (auto && !workingSpecificsXml.includes(auto)) {
          workingSpecificsXml += auto
          continue
        }
      }

      if (isTransientSystemError(parsed.short, parsed.long, parsed.codes) && !transientRetryUsed) {
        transientRetryUsed = true
        await sleep(700)
        continue
      }

      break
    }

    return {
      ok: false,
      categoryId: activeCategoryId,
      itemSpecificsXml: workingSpecificsXml,
      responseText,
      parsed,
      attemptedCategoryIds,
      errorKind,
    }
  }

  const attemptListing = async (params: typeof xmlParams & { itemSpecificsXml: string; shippingService?: string }) => {
    let activeCategoryId = params.categoryId
    let activeShippingService = params.shippingService || 'FedEx2Day'
    let responseText = ''
    let parsed = { short: '', long: '', codes: [] as string[], longs: [] as string[] }
    let errorKind: 'leaf' | 'specific' | 'other' = 'other'
    const attemptedCategoryIds: string[] = []
    const attemptedShippingServices: string[] = [activeShippingService]
    let transientRetryUsed = false
    let simplifiedShipping = false
    const shippingFallbacks = ['FedEx2Day', 'USPSPriority', 'FedExHomeDelivery', 'UPSGround']

    for (let guard = 0; guard < 4; guard += 1) {
      attemptedCategoryIds.push(activeCategoryId)
      responseText = await submitToEbay(buildXml({
        ...params,
        categoryId: activeCategoryId,
        shippingService: activeShippingService,
        simplifiedShipping,
      }), appId, credentials.accessToken)
      parsed = parse(responseText)
      errorKind = errType(parsed.short, parsed.long, parsed.codes)

      const replacementCategoryId = extractReplacementCategoryId(responseText)
      if (replacementCategoryId && replacementCategoryId !== activeCategoryId && !attemptedCategoryIds.includes(replacementCategoryId)) {
        activeCategoryId = replacementCategoryId
        continue
      }

      if (!simplifiedShipping && hasInvalidShippingDetails(parsed.short, parsed.long)) {
        simplifiedShipping = true
        continue
      }

      const unavailableShippingService = extractUnavailableShippingService(parsed.short, parsed.long)
      if (unavailableShippingService) {
        const nextShippingService = shippingFallbacks.find((service) => !attemptedShippingServices.includes(service))
        if (nextShippingService) {
          activeShippingService = nextShippingService
          attemptedShippingServices.push(nextShippingService)
          continue
        }
      }

      if (isTransientSystemError(parsed.short, parsed.long, parsed.codes) && !transientRetryUsed) {
        transientRetryUsed = true
        await sleep(700)
        continue
      }

      break
    }

    return {
      responseText,
      parsed,
      errorKind,
      categoryId: activeCategoryId,
      attemptedCategoryIds,
      shippingService: activeShippingService,
      attemptedShippingServices,
    }
  }

  let verifiedParams = { categoryId: preferredCategoryId, itemSpecificsXml }
  let verificationAttempts: string[] = []
  let verificationResponseText = ''
  let verificationError = ''

  for (const categoryId of categoryCandidates) {
    const verification = await verifyCategoryCandidate({ ...xmlParams, categoryId, itemSpecificsXml })
    verificationAttempts.push(...verification.attemptedCategoryIds)

    if (verification.ok) {
      verifiedParams = {
        categoryId: verification.categoryId,
        itemSpecificsXml: verification.itemSpecificsXml,
      }
      verificationResponseText = verification.responseText
      verificationError = ''
      break
    }

    verificationResponseText = verification.responseText
    verificationError = verification.parsed.long || verification.parsed.short
  }

  if (!verificationResponseText && categoryCandidates.length === 0) {
    verificationError = 'No usable eBay category candidates were returned for this listing.'
  }

  // ── Retry chain ──────────────────────────────────────────────────────────────
  let trialSlotReserved = false
  const releaseReservedTrialSlot = async () => {
    if (!trialSlotReserved) return
    trialSlotReserved = false
    await releaseTrialListingSlot(effectiveUserId)
  }

  if (trialApplies) {
    const reservation = await reserveTrialListingSlot(effectiveUserId, trialLimit)
    if (!reservation.ok) {
      return apiError(`Trial limit reached. You can list ${trialLimit} items for free — upgrade to keep listing.`, {
        status: 402,
        code: 'TRIAL_LIMIT_REACHED',
        details: { trialLimit, listed: reservation.listed },
      })
    }
    trialSlotReserved = true
  }

  let attempt: Awaited<ReturnType<typeof attemptListing>>
  let responseText = ''
  let p = { short: '', long: '', codes: [] as string[], longs: [] as string[] }
  let et: 'leaf' | 'specific' | 'other' = 'other'
  let finalCategoryId = verifiedParams.categoryId
  let attemptedCategoryIds = [...verificationAttempts]

  try {
  // Attempt 1: verified category with verified specifics
  attempt = await attemptListing({ ...xmlParams, ...verifiedParams })
  responseText = attempt.responseText
  p = attempt.parsed
  et = attempt.errorKind
  finalCategoryId = attempt.categoryId
  attemptedCategoryIds = [...verificationAttempts, ...attempt.attemptedCategoryIds]

  // Attempt 2: same category + auto-extracted required specifics from error
  if (et === 'specific') {
    const auto = autoSpecificsXml(responseText)
    attempt = await attemptListing({ ...xmlParams, categoryId: finalCategoryId, itemSpecificsXml: itemSpecificsXml + auto })
    responseText = attempt.responseText
    p = attempt.parsed
    et = attempt.errorKind
    finalCategoryId = attempt.categoryId
    attemptedCategoryIds = [...attemptedCategoryIds, ...attempt.attemptedCategoryIds]
    // Attempt 2b: only auto specifics (in case extracted specifics conflict)
    if (et === 'specific') {
      const auto2 = autoSpecificsXml(responseText)
      attempt = await attemptListing({ ...xmlParams, categoryId: finalCategoryId, itemSpecificsXml: auto2 })
      responseText = attempt.responseText
      p = attempt.parsed
      et = attempt.errorKind
      finalCategoryId = attempt.categoryId
      attemptedCategoryIds = [...attemptedCategoryIds, ...attempt.attemptedCategoryIds]
    }
  }

  // Attempt 3: if the preferred suggested category fails, try the remaining suggested categories from deepest to shallowest
  if ((et === 'leaf' || et === 'specific') && leafSuggestedCategoryIds.length > 1) {
    for (const categoryId of leafSuggestedCategoryIds.slice(1)) {
      if (categoryId === preferredCategoryId || attemptedCategoryIds.includes(categoryId)) continue
      attempt = await attemptListing({ ...xmlParams, categoryId, itemSpecificsXml })
      responseText = attempt.responseText
      p = attempt.parsed
      et = attempt.errorKind
      finalCategoryId = attempt.categoryId
      attemptedCategoryIds = [...attemptedCategoryIds, ...attempt.attemptedCategoryIds]
      if (et !== 'leaf' && et !== 'specific') break
    }
  }

  // Attempt 4: if the preferred tree still fails, try every remaining candidate once.
  if (et === 'leaf' || et === 'specific') {
    for (const categoryId of categoryCandidates) {
      if (!categoryId || attemptedCategoryIds.includes(categoryId)) continue
      attempt = await attemptListing({ ...xmlParams, categoryId, itemSpecificsXml })
      responseText = attempt.responseText
      p = attempt.parsed
      et = attempt.errorKind
      finalCategoryId = attempt.categoryId
      attemptedCategoryIds = [...attemptedCategoryIds, ...attempt.attemptedCategoryIds]
      if (et !== 'leaf' && et !== 'specific') break
    }
  }

  } catch (error) {
    await releaseReservedTrialSlot()
    throw error
  }

  const categoryDebug = {
    asinCategory,
    comparableCategory,
    taxonomyIds,
    legacySuggestions,
    nicheFallback,
    nicheCategoryId,
    candidates: categoryCandidates.map((categoryId) => ({
      categoryId,
      sources: categorySourceById.get(categoryId) || ['unknown'],
    })),
    selectedCategoryId: finalCategoryId,
    selectedSources: categorySourceById.get(finalCategoryId) || ['ebay-replacement-or-verified'],
  }

  const itemIdMatch = responseText.match(/<ItemID>(\d+)<\/ItemID>/)
  const ackMatch    = responseText.match(/<Ack>(.*?)<\/Ack>/)

  if (!itemIdMatch || ackMatch?.[1] === 'Failure') {
    // Collect all messages, skip pure deprecation warnings to surface the real error
    const allLong  = [...responseText.matchAll(/<LongMessage>(.*?)<\/LongMessage>/g)].map(m => m[1])
    const allShort = [...responseText.matchAll(/<ShortMessage>(.*?)<\/ShortMessage>/g)].map(m => m[1])
    const isWarningOnly = (s: string) => {
      const l = s.toLowerCase()
      return l.includes('deprecated') || l.includes('will be deprecated')
        || l.includes('condition is not applicable') || l.includes('condition value submitted has been dropped')
    }
    const errMsg =
      allLong.find(m => !isWarningOnly(m)) ||
      allShort.find(m => !isWarningOnly(m)) ||
      verificationError ||
      allLong[0] || allShort[0] ||
      responseText.slice(0, 400)
    await releaseReservedTrialSlot()
    if (errMsg.toLowerCase().includes('expired') || errMsg.toLowerCase().includes('auth token')) {
      return apiError('Your eBay session expired. Reconnect your account in Settings.', {
        status: 401,
        code: 'RECONNECT_REQUIRED',
      })
    }
    return apiError(errMsg, {
      status: 400,
      code: 'EBAY_LISTING_FAILED',
      details: {
        raw: responseText.slice(0, 1200),
        verificationRaw: verificationResponseText.slice(0, 1200),
        suggestedCategoryIds: leafSuggestedCategoryIds,
        attemptedCategoryIds: Array.from(new Set(attemptedCategoryIds)),
        finalCategoryId,
        categoryDebug,
      },
    })
  }

  const listingId = itemIdMatch[1]

  await ensureListedAsinsFinancialColumns()
  await sql`
    INSERT INTO listed_asins (user_id, asin, title, ebay_listing_id, amazon_price, ebay_price, ebay_fee_rate, amazon_image_url, amazon_images, amazon_snapshot, niche, category_id, amazon_available, amazon_status_reason, amazon_status_checked_at, image_count, image_quality_warning)
    VALUES (${effectiveUserId}, ${asin}, ${listingTitle.slice(0, 200)}, ${listingId}, ${listingAmazonPrice.toFixed(2)}, ${price}, ${EBAY_DEFAULT_FEE_RATE}, ${primarySourceImage}, ${JSON.stringify(filteredImages)}, ${JSON.stringify({
      asin,
      title: listingTitle,
      amazonPrice: listingAmazonPrice,
      imageUrl: primarySourceImage,
      images: filteredImages,
      features: amazon.features,
      description: amazon.description,
      specs: amazon.specs,
      pricing: pricingRecommendation,
      pricingWarning,
      available: validatedAmazon.available,
      source: validatedAmazon.source,
      imageQualityWarning,
      amazonUrl: `https://www.amazon.com/dp/${asin}`,
    })}, ${niche}, ${finalCategoryId}, TRUE, 'available', NOW(), ${filteredImages.length}, ${imageQualityWarning})
    ON CONFLICT (user_id, asin) DO UPDATE SET
      ebay_listing_id = ${listingId},
      title = ${listingTitle.slice(0, 200)},
      amazon_price = ${listingAmazonPrice.toFixed(2)},
      ebay_price = ${price},
      ebay_fee_rate = ${EBAY_DEFAULT_FEE_RATE},
      amazon_image_url = ${primarySourceImage},
      amazon_images = ${JSON.stringify(filteredImages)},
      amazon_snapshot = ${JSON.stringify({
        asin,
        title: listingTitle,
        amazonPrice: listingAmazonPrice,
        imageUrl: primarySourceImage,
        images: filteredImages,
        features: amazon.features,
        description: amazon.description,
        specs: amazon.specs,
        pricing: pricingRecommendation,
        pricingWarning,
        available: validatedAmazon.available,
        source: validatedAmazon.source,
        imageQualityWarning,
        amazonUrl: `https://www.amazon.com/dp/${asin}`,
      })},
      niche = ${niche},
      category_id = ${finalCategoryId},
      amazon_available = TRUE,
      amazon_status_reason = 'available',
      amazon_status_checked_at = NOW(),
      image_count = ${filteredImages.length},
      image_quality_warning = ${imageQualityWarning},
      listed_at = NOW(),
      ended_at = NULL
  `.catch(() => {})

  trialSlotReserved = false
  const latestTrialUsage = trialApplies ? await getTrialUsage(effectiveUserId) : null

  return apiOk({
    success: true,
    listingId,
    listingUrl: `https://www.ebay.com/itm/${listingId}`,
    imageCount: filteredImages.length,
    imageQualityWarning,
    subscription: latestTrialUsage
      ? {
          plan,
          trialLimit,
          listed: latestTrialUsage.listed,
          trialRemaining: Math.max(0, trialLimit - latestTrialUsage.listed),
        }
      : undefined,
    _debug: {
      amazonImages: amazon.images.length,
      featuresCount: amazon.features.length,
      featuresSource: amazon.features.length > 0 && amazon.features[0].startsWith('Brand new') ? 'fallback' : 'amazon',
      epsUploaded: usablePictureList.filter(u => u.includes('ebayimg.com')).length,
      pictureListLength: usablePictureList.length,
      apiError: (amazon as { _apiError?: string })._apiError,
      validatedSource: validatedAmazon.source,
      usedFallbackTitle: validatedAmazon.usedFallbackTitle,
      usedFallbackPrice: validatedAmazon.usedFallbackPrice,
      category: categoryDebug,
    },
  })
}


