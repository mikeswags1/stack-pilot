import { decodeHtmlEntitiesDeep } from '@/lib/html-entities'

const AMAZON_BADGE_PATTERN =
  /\[?\b(amazon['']?s?\s+choice|overall\s+pick|#?\s*1\s+best\s+seller|best\s+seller|limited\s+time\s+deal|climate\s+pledge\s+friendly|small\s+business|sponsored|top\s+brand|highly\s+rated|deal\s+of\s+the\s+day)\b\]?/gi

const TITLE_STOP_WORDS = new Set([
  'and', 'the', 'with', 'for', 'from', 'that', 'this', 'your', 'you', 'are',
  'new', 'brand', 'store', 'official', 'pack', 'packs', 'set', 'sets', 'piece',
  'pieces', 'pcs', 'count', 'counts', 'unit', 'units', 'item', 'items', 'each',
  'lot', 'bulk', 'sale', 'black', 'white', 'blue', 'red', 'green', 'gray', 'grey',
  'pink', 'purple', 'brown', 'gold', 'silver', 'clear',
])

const PRODUCT_SIGNAL_WORDS = new Set([
  'accessory', 'adapter', 'bag', 'band', 'basket', 'battery', 'blanket', 'bottle',
  'box', 'brace', 'bracket', 'brush', 'bulb', 'cable', 'case', 'charger', 'clip',
  'clips', 'cover', 'cup', 'divider', 'dock', 'filter', 'gloves', 'guard', 'holder',
  'hose', 'kit', 'lamp', 'light', 'mat', 'mount', 'organizer', 'pad', 'pads', 'paper',
  'plate', 'protector', 'rack', 'refill', 'roll', 'rug', 'scanner', 'screen', 'shelf',
  'shirt', 'sleeve', 'socks', 'stand', 'station', 'strap', 'table', 'tape', 'towel',
  'tray', 'tube', 'wallet', 'wrap',
])

const GENERIC_FALLBACK_TITLE_PATTERNS = [
  /^generic\s+product(?:\s*[-:]\s*)?/i,
  /^product\s*[-:]\s*(?:professional|premium|quality|industrial|home|office|outdoor)/i,
  /\bprofessional\s+industrial\s+equipment\b/i,
  /\bpremium\s+industrial\s+equipment\b/i,
]

export function cleanListingTitleCandidate(value: unknown) {
  return decodeHtmlEntitiesDeep(value)
    .replace(AMAZON_BADGE_PATTERN, '')
    .replace(/\bvisit\s+the\s+.+?\s+store\b/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>"]/g, ' ')
    .replace(/\s*[-|,]\s*(Pack of|Pack|Count|Piece|Pcs|Units?|Set of)\s*\d+\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isGenericFallbackListingTitle(value: unknown) {
  const cleanTitle = cleanListingTitleCandidate(value)
  if (!cleanTitle) return false
  return GENERIC_FALLBACK_TITLE_PATTERNS.some((pattern) => pattern.test(cleanTitle))
}

export function getMeaningfulTitleWords(value: unknown) {
  return cleanListingTitleCandidate(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((word) => word.trim())
    .filter((word) => word.length > 1)
    .filter((word) => !TITLE_STOP_WORDS.has(word))
}

function hasProductSignal(words: string[]) {
  return words.some((word) => (
    PRODUCT_SIGNAL_WORDS.has(word) ||
    /(?:case|charger|holder|organizer|protector|adapter|scanner|divider|towel|socks?|lamp|brace|wallet|mount|stand|filter|brush|cable|battery|screen|shirt|tube|clips?)$/.test(word)
  ))
}

export function getListingTitleQuality(value: unknown) {
  const cleanTitle = cleanListingTitleCandidate(value)
  const words = getMeaningfulTitleWords(cleanTitle)
  const uniqueWords = Array.from(new Set(words))
  const tokenCount = cleanTitle.split(/\s+/).filter(Boolean).length
  const compact = cleanTitle.replace(/[^A-Za-z0-9]/g, '')
  const brandLikeSingleToken =
    tokenCount <= 1 &&
    compact.length >= 3 &&
    compact.length <= 24 &&
    /^[A-Z0-9]+$/.test(compact)
  const productSignal = hasProductSignal(uniqueWords)
  const hasNumber = /\d/.test(cleanTitle)
  const genericFallback = isGenericFallbackListingTitle(cleanTitle)
  const weak =
    cleanTitle.length === 0 ||
    genericFallback ||
    brandLikeSingleToken ||
    uniqueWords.length <= 2 ||
    (cleanTitle.length < 14 && uniqueWords.length < 4) ||
    (!productSignal && uniqueWords.length < 4)

  const score =
    uniqueWords.length * 10 +
    Math.min(cleanTitle.length, 90) / 4 +
    (productSignal ? 30 : 0) +
    (hasNumber ? 4 : 0) -
    (weak ? 100 : 0)

  return {
    cleanTitle,
    meaningfulWordCount: uniqueWords.length,
    hasProductSignal: productSignal,
    weak,
    genericFallback,
    score,
  }
}

export function isWeakListingTitle(value: unknown) {
  return getListingTitleQuality(value).weak
}

export function chooseBestListingTitle(candidates: unknown[]) {
  return candidates
    .map((candidate, index) => {
      const quality = getListingTitleQuality(candidate)
      return {
        title: quality.cleanTitle,
        score: quality.score - index * 0.5,
      }
    })
    .filter((candidate) => candidate.title.length > 0)
    .sort((a, b) => b.score - a.score)[0]?.title || ''
}
