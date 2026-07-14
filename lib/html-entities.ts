const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

// Recognized entity forms that should never be visible in a published eBay title.
// Repeated "amp;" catches nested encoding such as &amp;amp;#x27;.
const TITLE_ENTITY_ARTIFACT =
  /&(?:amp;)*(?:#(?:x[0-9a-f]{1,6}|[0-9]{1,7});?|(?:amp|apos|gt|lt|nbsp|quot);)/i

function decodeNumericEntity(match: string, hexValue?: string, decimalValue?: string) {
  const codePoint = Number.parseInt(hexValue || decimalValue || '', hexValue ? 16 : 10)
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return match
  }

  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return match
  }
}

function decodeOnePass(value: string) {
  return value
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi, decodeNumericEntity)
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/gi, (match, name: string) => (
      NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match
    ))
}

/**
 * Decode common named, decimal, and hexadecimal HTML entities until the text stops
 * changing. Output is plain text; XML escaping belongs only at serialization.
 */
export function decodeHtmlEntitiesDeep(value: unknown, maxPasses = 4) {
  let decoded = String(value || '')
  const passes = Math.max(1, Math.min(8, Math.floor(maxPasses) || 1))

  for (let pass = 0; pass < passes; pass += 1) {
    const next = decodeOnePass(decoded)
    if (next === decoded) break
    decoded = next
  }

  return decoded
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
}

/** True only for encoded residue, not a legitimate bare ampersand. */
export function hasEncodedTitleArtifact(value: unknown) {
  return TITLE_ENTITY_ARTIFACT.test(String(value || ''))
}

/**
 * Mechanical repair for an already-published eBay title. No brand or SEO rewriting.
 */
export function repairEncodedEbayTitle(value: unknown) {
  return decodeHtmlEntitiesDeep(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
