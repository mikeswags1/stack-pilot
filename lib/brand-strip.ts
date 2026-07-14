// Shared brand-stripping used by both the live listing pipeline (new listings) and the
// retitle-brands tool (existing listings). Amazon titles lead with an obscure marketplace
// brand ("Kacctyen", "SONGMICS", "DkOvn") that means nothing to eBay buyers and just eats
// the 80-char title. We strip that leading brand while KEEPING recognized brands people
// actually search (iPhone, Nike…) and never mangling normal product-word-led titles.

import { decodeHtmlEntitiesDeep } from '@/lib/html-entities'

const GENERIC_BRAND_VALUES = new Set([
  'replacement', 'compatible', 'universal', 'generic', 'new', 'brand', 'for', 'unbranded',
])

// Short/common all-caps tokens that are NOT brands — never strip these as a "brand".
const COMMON_ACRONYMS = new Set([
  'USB', 'LED', 'LCD', 'OLED', 'USA', 'UPF', 'OEM', 'HDMI', 'XXL', 'XL', 'BPA', 'UV', 'SUV',
  'RGB', 'PS5', 'PS4', 'ABS', 'PVC', 'EVA', 'TPU', 'DIY', 'HD', '4K', '3D', 'ID', 'US', 'EU',
  'UK', 'FDA', 'NEW', 'SET', 'PCS', 'PACK', 'KIT', '2X', '3X', '4X', '2PC', '3PC', '4PC', 'SS',
  'XS', 'SM', 'LG',
])

// Recognized brands worth KEEPING — they're real search keywords, not "random" brands.
const KEEP_BRANDS = new Set([
  'iphone', 'ipad', 'apple', 'samsung', 'galaxy', 'sony', 'nike', 'adidas', 'lego', 'bose',
  'anker', 'dewalt', 'makita', 'pyrex', 'crocs', 'hasbro', 'disney', 'marvel', 'nintendo',
  'xbox', 'playstation', 'yeti', 'stanley', 'hydroflask', 'carhartt', 'levis', 'columbia',
  'logitech', 'razer', 'hp', 'dell', 'lenovo', 'asus', 'acer', 'canon', 'nikon', 'gopro',
  'fitbit', 'garmin',
])

function firstTokenMatch(s: string): string | null {
  const m = s.trim().match(/^([A-Za-z][A-Za-z0-9'&.\-]*)/)
  return m ? m[1] : null
}

function isAllCapsBrand(tok: string): boolean {
  const letters = tok.replace(/[^A-Za-z]/g, '')
  if (letters.length < 4) return false
  if (!/^[A-Z0-9'&.\-]+$/.test(tok)) return false
  if (!/[A-Z]/.test(tok)) return false
  if (COMMON_ACRONYMS.has(tok.toUpperCase())) return false
  return true
}

function isOddCaseBrand(tok: string): boolean {
  // A title normally starts with a Capitalized word, so these leading shapes signal a brand:
  //   camelCase (DkOvn, CircleRoad), lower-then-cap (iCasso), or all-lowercase (baleaf).
  if (COMMON_ACRONYMS.has(tok.toUpperCase())) return false
  if (/^[A-Z][a-z]+[A-Z]/.test(tok)) return true
  if (/^[a-z]+[A-Z]/.test(tok)) return true
  if (/^[a-z]{3,}$/.test(tok)) return true
  return false
}

function removeLeadingToken(title: string, tok: string): string {
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Negative lookahead keeps us from slicing a longer word (brand "Song" ≠ "Songmics").
  return title.replace(new RegExp(`^\\s*${esc}[®™]?(?![A-Za-z0-9])[\\s:\\-|,]*`, 'i'), '')
}

/**
 * Remove the leading brand from a title. Tries the precise Brand spec value first (when
 * available), then a high-precision shape heuristic. Returns the original title unchanged
 * whenever stripping would be unsafe (recognized brand, too little left, ambiguous).
 */
export function stripLeadingBrand(title: string, brandSpec?: string): string {
  const original = title
  const t = title.trim()

  // 1) Precise: strip the product's real Brand spec value when the title starts with it.
  const brand = (brandSpec || '').trim()
  if (brand.length >= 2 && !GENERIC_BRAND_VALUES.has(brand.toLowerCase()) && !KEEP_BRANDS.has(brand.toLowerCase())) {
    const s = removeLeadingToken(t, brand).trim()
    if (s !== t && s.length >= 12 && /[a-z]/i.test(s)) return s
  }

  // 2) Heuristic by shape: obscure brands have a tell-tale leading token shape.
  const tok1 = firstTokenMatch(t)
  if (tok1 && !KEEP_BRANDS.has(tok1.toLowerCase()) && (isAllCapsBrand(tok1) || isOddCaseBrand(tok1))) {
    let rest = removeLeadingToken(t, tok1)
    // Two-word ALL-CAPS brand (GRANNY SAYS, JANE EYRE): consume a 2nd all-caps token.
    const tok2 = firstTokenMatch(rest)
    if (tok2 && isAllCapsBrand(tok2) && !KEEP_BRANDS.has(tok2.toLowerCase())) rest = removeLeadingToken(rest, tok2)
    rest = rest.trim()
    if (rest.length >= 12 && /[a-z]/i.test(rest) && rest.split(/\s+/).length >= 2) return rest
  }

  return original
}

// Decode entities, drop Amazon-only badges, strip non-ASCII / XML-hostile chars, collapse
// whitespace. The shared front half of turning a raw Amazon title into an eBay title.
function sanitizeRawTitle(rawTitle: string): string {
  return decodeHtmlEntitiesDeep(rawTitle)
    .replace(/\[?\b(amazon['’]?s?\s+choice|overall\s+pick|#?\s*1\s+best\s+seller|best\s+seller|limited\s+time\s+deal|climate\s+pledge\s+friendly|small\s+business|sponsored|top\s+brand|highly\s+rated|deal\s+of\s+the\s+day)\b\]?/gi, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>"]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function capTo80(title: string): string {
  if (title.length <= 80) return title
  let t = title.slice(0, 80).replace(/\s+\S*$/, '').trim()
  t = t.replace(/\s+(?:with|for|in|to|of|and|or|a|an|the|by|at|from|as|into|&|\+)$/i, '').trim()
  t = t.replace(/[\s,;:\-|]+$/, '').trim()
  return t
}

/**
 * Turn a raw (possibly 200-char, entity-encoded) Amazon title into a clean, brand-free,
 * eBay-ready title (<=80 chars, word boundary), and report whether a leading brand was
 * actually removed. Used by the retitle-brands tool to select + rewrite existing listings.
 */
export function retitleForBrand(rawTitle: string, brandSpec?: string): { title: string; brandStripped: boolean } {
  const sanitized = sanitizeRawTitle(rawTitle)
  const stripped = stripLeadingBrand(sanitized, brandSpec).trim()
  return { title: capTo80(stripped), brandStripped: stripped !== sanitized }
}
