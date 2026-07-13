import { sql, queryRows } from '@/lib/db'
import { ensureListedAsinsFinancialColumns } from '@/lib/listed-asins'
import { fetchAmazonProductByAsin } from '@/lib/amazon-product'
import { scrapeAmazonSearch } from '@/lib/amazon-scrape'

export function normalizeLookupTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(pack|set|pcs|piece|pieces|count|with|for|the|a|an|of|to|in)\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function getTitleScore(ebayTitle: string, candidateTitle: string) {
  return getTitleMatch(ebayTitle, candidateTitle).score
}

const IMPORTANT_WORD_STOPLIST = new Set([
  'new',
  'free',
  'ship',
  'shipping',
  'fast',
  'sale',
  'home',
  'office',
  'premium',
  'heavy',
  'duty',
  'compatible',
  'replacement',
  'assorted',
  'color',
  'colors',
])

function getLookupWords(value: string) {
  return normalizeLookupTitle(value)
    .split(' ')
    .filter((word) => word.length > 2 && !IMPORTANT_WORD_STOPLIST.has(word))
}

function getImportantWords(value: string) {
  return getLookupWords(value).filter((word) => (
    /\d/.test(word) ||
    word.length >= 5 ||
    /^[a-z]+\d+[a-z0-9]*$/.test(word) ||
    /^[a-z0-9]*\d+[a-z]+$/.test(word)
  ))
}

function getQuantitySignals(value: string) {
  const normalized = normalizeLookupTitle(value)
  const signals = new Set<string>()
  const patterns = [
    /\b(\d{1,4})\s*(pack|pk|count|ct|pcs|piece|pieces|roll|rolls|sheet|sheets|oz|ounce|ounces|lb|lbs|inch|inches|ft|feet)\b/g,
    /\b(pack|pk|count|ct|pcs|piece|pieces|roll|rolls|sheet|sheets|oz|ounce|ounces|lb|lbs|inch|inches|ft|feet)\s*(of\s*)?(\d{1,4})\b/g,
  ]

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const amount = match[1] && /^\d/.test(match[1]) ? match[1] : match[3]
      const unit = match[2] && !/of/.test(match[2]) ? match[2] : match[1]
      if (amount && unit) signals.add(`${amount}:${normalizeQuantityUnit(unit)}`)
    }
  }

  return signals
}

function normalizeQuantityUnit(unit: string) {
  const clean = unit.toLowerCase().replace(/s$/, '')
  if (['pack', 'pk', 'count', 'ct', 'pcs', 'piece'].includes(clean)) return 'unit'
  if (['ounce', 'oz'].includes(clean)) return 'oz'
  if (['lb', 'lbs'].includes(clean)) return 'lb'
  if (['inch', 'inche'].includes(clean)) return 'inch'
  if (['ft', 'feet'].includes(clean)) return 'ft'
  return clean
}

function hasQuantityConflict(ebayTitle: string, candidateTitle: string) {
  const ebaySignals = getQuantitySignals(ebayTitle)
  const candidateSignals = getQuantitySignals(candidateTitle)
  if (ebaySignals.size === 0 || candidateSignals.size === 0) return false

  for (const signal of ebaySignals) {
    if (candidateSignals.has(signal)) return false
  }

  return true
}

export function getTitleMatch(ebayTitle: string, candidateTitle: string) {
  const ebayWords = new Set(getLookupWords(ebayTitle))
  const candidateWords = new Set(getLookupWords(candidateTitle))
  if (ebayWords.size === 0 || candidateWords.size === 0) {
    return { score: 0, queryCoverage: 0, importantCoverage: 0, quantityConflict: false }
  }

  let overlap = 0
  for (const word of ebayWords) {
    if (candidateWords.has(word)) overlap += 1
  }

  const importantWords = getImportantWords(ebayTitle)
  const importantMatches = importantWords.filter((word) => candidateWords.has(word)).length
  const queryCoverage = overlap / ebayWords.size
  const candidateCoverage = overlap / candidateWords.size
  const importantCoverage = importantWords.length > 0 ? importantMatches / importantWords.length : queryCoverage
  const quantityConflict = hasQuantityConflict(ebayTitle, candidateTitle)
  const score = Math.max(
    0,
    Math.min(1, (queryCoverage * 0.55) + (candidateCoverage * 0.2) + (importantCoverage * 0.25) - (quantityConflict ? 0.25 : 0))
  )

  return {
    score,
    queryCoverage,
    importantCoverage,
    quantityConflict,
  }
}

type TitleCandidate = {
  asin: string
  title: string
  price?: number
  imageUrl?: string
}

function chooseBestTitleCandidate(ebayTitle: string, candidates: TitleCandidate[], minScore: number) {
  const ranked = candidates
    .map((candidate) => ({ ...candidate, match: getTitleMatch(ebayTitle, candidate.title) }))
    .filter((candidate) => /^[A-Z0-9]{10}$/i.test(candidate.asin))
    .filter((candidate) => candidate.match.score >= minScore)
    .filter((candidate) => candidate.match.queryCoverage >= 0.45)
    .filter((candidate) => candidate.match.importantCoverage >= 0.5)
    .filter((candidate) => !candidate.match.quantityConflict)
    .sort((a, b) => b.match.score - a.match.score)

  const best = ranked[0]
  const second = ranked[1]
  if (!best) return null
  if (second && best.match.score - second.match.score < 0.05) return null

  return best
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function getXmlValue(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match?.[1] ? decodeXml(match[1]) : ''
}

function getXmlValues(xml: string, tag: string) {
  return Array.from(xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi')))
    .map((match) => decodeXml(match[1] || ''))
    .filter(Boolean)
}

function stripHtml(value: string) {
  return decodeXml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractAsinsFromText(...values: Array<string | null | undefined>) {
  const found = new Set<string>()
  for (const value of values) {
    const text = String(value || '').toUpperCase()
    for (const match of text.matchAll(/\bB[A-Z0-9]{9}\b/g)) {
      found.add(match[0])
    }
  }
  return Array.from(found)
}

type EbayItemDetails = {
  title: string
  sku: string
  description: string
  itemSpecifics: Array<{ name: string; values: string[] }>
  possibleAsins: string[]
}

function normalizeNameValueList(value: unknown): Array<{ name: string; values: string[] }> {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .map((entry) => {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
      const rawValues = record.Value || record.value || []
      const values = (Array.isArray(rawValues) ? rawValues : [rawValues])
        .map((item) => String(item || '').trim())
        .filter(Boolean)

      return {
        name: String(record.Name || record.name || '').trim(),
        values,
      }
    })
    .filter((specific) => specific.name || specific.values.length > 0)
}

async function getPublicEbayItemDetails(itemId: string, appId: string): Promise<EbayItemDetails | null> {
  if (!appId) return null

  const params = new URLSearchParams({
    callname: 'GetSingleItem',
    responseencoding: 'JSON',
    appid: appId,
    siteid: '0',
    version: '1199',
    ItemID: itemId,
    IncludeSelector: 'Details,Description,ItemSpecifics',
  })

  const res = await fetch(`https://open.api.ebay.com/shopping?${params.toString()}`, {
    signal: AbortSignal.timeout(8000),
  })

  if (!res.ok) return null

  const data = await res.json().catch(() => null)
  const item = data?.Item && typeof data.Item === 'object' ? data.Item as Record<string, unknown> : null
  if (!item) return null

  const itemSpecificsContainer = item.ItemSpecifics && typeof item.ItemSpecifics === 'object'
    ? item.ItemSpecifics as Record<string, unknown>
    : {}
  const itemSpecifics = normalizeNameValueList(itemSpecificsContainer.NameValueList)
  const title = String(item.Title || '').trim()
  const sku = String(item.SKU || item.SellerSKU || '').trim()
  const description = stripHtml(String(item.Description || ''))
  const specificText = itemSpecifics
    .flatMap((specific) => [specific.name, ...specific.values])
    .join(' ')

  if (!title && !sku && !description && !specificText) return null

  return {
    title,
    sku,
    description,
    itemSpecifics,
    possibleAsins: extractAsinsFromText(sku, specificText, description, title),
  }
}

export async function getEbayItemDetails(itemId: string, token: string, appId: string): Promise<EbayItemDetails | null> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ItemReturnDescription</DetailLevel>
  <OutputSelector>Title</OutputSelector>
  <OutputSelector>SKU</OutputSelector>
  <OutputSelector>Description</OutputSelector>
  <OutputSelector>ItemSpecifics</OutputSelector>
  <OutputSelector>PictureDetails</OutputSelector>
</GetItemRequest>`

  try {
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(8000),
    })

    if (res.ok) {
      const text = await res.text()
      const title = getXmlValue(text, 'Title')
      const sku = getXmlValue(text, 'SKU')
      const description = stripHtml(getXmlValue(text, 'Description'))
      const itemSpecifics = Array.from(text.matchAll(/<NameValueList>([\s\S]*?)<\/NameValueList>/gi))
        .map((match) => {
          const block = match[1] || ''
          return {
            name: getXmlValue(block, 'Name'),
            values: getXmlValues(block, 'Value'),
          }
        })
        .filter((specific) => specific.name || specific.values.length > 0)

      const specificText = itemSpecifics
        .flatMap((specific) => [specific.name, ...specific.values])
        .join(' ')

      if (title || sku || description || specificText) {
        return {
          title,
          sku,
          description,
          itemSpecifics,
          possibleAsins: extractAsinsFromText(sku, specificText, description, title),
        }
      }
    }
  } catch {
    // Fall through to public Shopping API lookup.
  }

  return getPublicEbayItemDetails(itemId, appId)
}

export async function getEbayItemTitle(itemId: string, token: string, appId: string): Promise<string | null> {
  const details = await getEbayItemDetails(itemId, token, appId)
  return details?.title || null
}

export async function saveRecoveredMapping(args: {
  userId: string
  itemId: string
  asin: string
  title: string
  amazonPrice: number
  amazonImageUrl?: string
  amazonImages?: string[]
  amazonSnapshot?: Record<string, unknown>
}) {
  await ensureListedAsinsFinancialColumns()
  await sql`
    UPDATE listed_asins
    SET ebay_listing_id = NULL
    WHERE user_id = ${args.userId}
      AND ebay_listing_id = ${args.itemId}
      AND asin <> ${args.asin}
  `
  await sql`
    INSERT INTO listed_asins (user_id, asin, title, ebay_listing_id, amazon_price, amazon_image_url, amazon_images, amazon_snapshot)
    VALUES (${args.userId}, ${args.asin}, ${args.title.slice(0, 200)}, ${args.itemId}, ${args.amazonPrice.toFixed(2)}, ${args.amazonImageUrl || null}, ${JSON.stringify(args.amazonImages || [])}, ${JSON.stringify(args.amazonSnapshot || null)})
    ON CONFLICT (user_id, asin) DO UPDATE SET
      title = ${args.title.slice(0, 200)},
      ebay_listing_id = ${args.itemId},
      amazon_price = ${args.amazonPrice.toFixed(2)},
      amazon_image_url = ${args.amazonImageUrl || null},
      amazon_images = ${JSON.stringify(args.amazonImages || [])},
      amazon_snapshot = COALESCE(${JSON.stringify(args.amazonSnapshot || null)}::jsonb, listed_asins.amazon_snapshot),
      listed_at = NOW()
  `
}

type StoredMappingRow = {
  asin?: string
  title?: string
  amazon_price?: string | number
  amazon_image_url?: string | null
  amazon_images?: unknown
  amazon_snapshot?: unknown
}

export type RecoveredAmazonMapping = {
  asin: string
  title: string
  amazonPrice: number
  imageUrl?: string
  images: string[]
  features: unknown[]
  description: string
  specs: unknown[]
  amazonUrl: string
  available: boolean
  source: 'db' | 'search'
  ebayTitle?: string
  confidence?: 'exact' | 'manual' | 'recovered' | 'search'
}

export async function recoverAmazonProductByItemId(args: {
  userId: string
  itemId: string
  accessToken: string
  appId: string
  rapidKey?: string
  excludeAsins?: string[]
}): Promise<RecoveredAmazonMapping | null> {
  const { userId, itemId, accessToken, appId, rapidKey } = args
  const excludedAsins = new Set((args.excludeAsins || []).map((asin) => asin.toUpperCase().trim()).filter(Boolean))
  const shouldSkipAsin = (asin: string) => excludedAsins.has(asin.toUpperCase().trim())

  if (excludedAsins.size === 0) {
    try {
    const rows = await queryRows<StoredMappingRow>`
      SELECT asin, title, amazon_price, amazon_image_url, amazon_images, amazon_snapshot
      FROM listed_asins
      WHERE user_id = ${userId} AND ebay_listing_id = ${itemId}
      LIMIT 1
    `

    if (rows[0]?.asin) {
      const asin = String(rows[0].asin)
      const snapshot = rows[0].amazon_snapshot && typeof rows[0].amazon_snapshot === 'object'
        ? rows[0].amazon_snapshot as Record<string, unknown>
        : null
      const storedPrice = parseFloat(String(rows[0].amazon_price || '0')) || 0
      const storedImages = Array.isArray(rows[0].amazon_images)
        ? rows[0].amazon_images.map((value) => String(value || '')).filter((value) => value.startsWith('http'))
        : []
      const snapshotImages = Array.isArray(snapshot?.images)
        ? snapshot.images.map((value) => String(value || '')).filter((value) => value.startsWith('http'))
        : []
      const storedImageUrl =
        String(snapshot?.imageUrl || '') ||
        String(rows[0].amazon_image_url || '') ||
        snapshotImages[0] ||
        storedImages[0] ||
        undefined

      const validated = await fetchAmazonProductByAsin({ asin, strictAsin: true })

      if (!validated) {
        if (storedPrice > 0) {
          const storedTitle = String(snapshot?.title || rows[0].title || asin)
          return {
            asin,
            title: storedTitle,
            amazonPrice: storedPrice,
            imageUrl: storedImageUrl,
            images: snapshotImages.length > 0 ? snapshotImages : storedImages,
            features: Array.isArray(snapshot?.features) ? snapshot.features : [],
            description: String(snapshot?.description || ''),
            specs: Array.isArray(snapshot?.specs) ? snapshot.specs : [],
            amazonUrl: String(
              snapshot?.amazonUrl ||
              (storedTitle ? `https://www.amazon.com/s?k=${encodeURIComponent(storedTitle)}` : `https://www.amazon.com/dp/${asin}`)
            ),
            available: true,
            source: 'db',
            confidence: 'recovered',
          }
        }
      } else {
        if (validated.amazonPrice > 0) {
          await saveRecoveredMapping({
            userId,
            itemId,
            asin,
            title: String(validated.title || rows[0].title || asin),
            amazonPrice: validated.amazonPrice,
            amazonImageUrl: validated.imageUrl,
            amazonImages: validated.images,
            amazonSnapshot: {
              asin: validated.asin,
              title: validated.title,
              amazonPrice: validated.amazonPrice,
              imageUrl: validated.imageUrl,
              images: validated.images,
              features: validated.features,
              description: validated.description,
              specs: validated.specs,
              available: validated.available,
              source: validated.source,
              amazonUrl: `https://www.amazon.com/dp/${validated.asin}`,
            },
          })
        }

        return {
          asin,
          title: String(validated.title || snapshot?.title || rows[0].title || asin),
          amazonPrice: validated.amazonPrice,
          imageUrl: validated.imageUrl || storedImageUrl,
          images: validated.images.length > 0 ? validated.images : (snapshotImages.length > 0 ? snapshotImages : storedImages),
          features: validated.features,
          description: validated.description,
          specs: validated.specs,
          amazonUrl: `https://www.amazon.com/dp/${asin}`,
          available: validated.available,
          source: 'db',
          confidence: 'recovered',
        }
      }
    }
    } catch {
      // Fall through to eBay title lookup.
    }
  }

  const ebayDetails = await getEbayItemDetails(itemId, accessToken, appId)
  const ebayTitle = ebayDetails?.title || ''
  if (!ebayTitle) return null

  for (const asin of ebayDetails?.possibleAsins || []) {
    if (shouldSkipAsin(asin)) continue
    const validated = await fetchAmazonProductByAsin({ asin, strictAsin: true })

    if (validated) {
      await saveRecoveredMapping({
        userId,
        itemId,
        asin: validated.asin,
        title: validated.title,
        amazonPrice: validated.amazonPrice,
        amazonImageUrl: validated.imageUrl,
        amazonImages: validated.images,
        amazonSnapshot: {
          asin: validated.asin,
          title: validated.title,
          amazonPrice: validated.amazonPrice,
          imageUrl: validated.imageUrl,
          images: validated.images,
          features: validated.features,
          description: validated.description,
          specs: validated.specs,
          available: validated.available,
          source: validated.source,
          amazonUrl: `https://www.amazon.com/dp/${validated.asin}`,
          recoveredFrom: 'ebay_listing_asin',
        },
      })

      return {
        asin: validated.asin,
        title: validated.title,
        amazonPrice: validated.amazonPrice,
        imageUrl: validated.imageUrl,
        images: validated.images,
        features: validated.features,
        description: validated.description,
        specs: validated.specs,
        amazonUrl: `https://www.amazon.com/dp/${validated.asin}`,
        available: validated.available,
        ebayTitle,
        source: 'search',
        confidence: 'exact',
      }
    }
  }

  let products: Record<string, unknown>[] = []
  if (rapidKey) {
    const searchRes = await fetch(
      `https://real-time-amazon-data.p.rapidapi.com/search?query=${encodeURIComponent(ebayTitle)}&country=US&category_id=aps&page=1`,
      {
        headers: {
          'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com',
          'x-rapidapi-key': rapidKey,
        },
        signal: AbortSignal.timeout(8000),
      }
    ).catch(() => null)

    if (searchRes?.ok) {
      const searchJson = await searchRes.json()
      products = searchJson?.data?.products || []
    }
  }

  if (products.length > 0) {
    const candidates = products
      .map((product) => ({
        asin: String(product.asin || '').toUpperCase(),
        title: String(product.product_title || ''),
      }))
      .filter((product) => product.asin && product.title)
      .filter((product) => !shouldSkipAsin(product.asin))
    const bestCandidate = chooseBestTitleCandidate(ebayTitle, candidates, 0.64)

    if (bestCandidate?.asin) {
      const validated = await fetchAmazonProductByAsin({ asin: bestCandidate.asin, strictAsin: true })

      if (validated && getTitleMatch(ebayTitle, validated.title || bestCandidate.title).score >= 0.58) {
        return {
          asin: validated.asin,
          title: validated.title,
          amazonPrice: validated.amazonPrice,
          imageUrl: validated.imageUrl,
          images: validated.images,
          features: validated.features,
          description: validated.description,
          specs: validated.specs,
          amazonUrl: `https://www.amazon.com/dp/${validated.asin}`,
          available: validated.available,
          ebayTitle,
          source: 'search',
          confidence: 'search',
        }
      }
    }
  }

  const scraped = await scrapeAmazonSearch(ebayTitle)
  if (scraped.length > 0) {
    const scrapedCandidates = scraped
      .map((product) => ({
        asin: product.asin.toUpperCase(),
        title: product.title,
        price: product.price,
        imageUrl: product.imageUrl,
      }))
      .filter((product) => !shouldSkipAsin(product.asin))
    const bestScraped = chooseBestTitleCandidate(ebayTitle, scrapedCandidates, 0.68)

    if (bestScraped?.asin) {
      const validated = await fetchAmazonProductByAsin({ asin: bestScraped.asin, fallbackImage: bestScraped.imageUrl, strictAsin: true })

      if (validated && getTitleMatch(ebayTitle, validated.title || bestScraped.title).score >= 0.58) {
        return {
          asin: validated.asin,
          title: validated.title,
          amazonPrice: validated.amazonPrice,
          imageUrl: validated.imageUrl,
          images: validated.images,
          features: validated.features,
          description: validated.description,
          specs: validated.specs,
          amazonUrl: `https://www.amazon.com/dp/${validated.asin}`,
          available: validated.available,
          ebayTitle,
          source: 'search',
          confidence: 'search',
        }
      }
    }
  }

  return null
}
