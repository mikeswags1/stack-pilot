function parsePriceFromScope(scope: string): number {
  const patterns = [
    // The screen-reader value includes cents and appears first inside priceToPay.
    /class="[^"]*a-offscreen[^"]*"[^>]*>\s*\$\s*([\d,]+(?:\.\d{2})?)/i,
    /id="price_inside_buybox"[^>]*>\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /id="newBuyBoxPrice"[^>]*>\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /id="priceblock_(?:ourprice|dealprice)"[^>]*>\s*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /class="[^"]*\ba-price-whole\b[^"]*"[^>]*>([\d,]+)[\s\S]{0,300}?class="[^"]*\ba-price-fraction\b[^"]*"[^>]*>(\d{2})</i,
  ]

  for (const pattern of patterns) {
    const match = scope.match(pattern)
    if (!match) continue
    const raw = match[2] ? `${match[1]}.${match[2]}` : match[1]
    const value = Number.parseFloat(raw.replace(/,/g, ''))
    if (Number.isFinite(value) && value >= 1) return value
  }
  return 0
}

function removeScriptsAndStyles(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
}

function extractBalancedElement(html: string, start: number, fallbackLength: number) {
  const opening = html.slice(start).match(/^<([a-z][a-z0-9-]*)\b[^>]*>/i)
  if (!opening) return html.slice(start, start + fallbackLength)
  const tag = opening[1]
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi')
  tags.lastIndex = start
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tags.exec(html))) {
    const token = match[0]
    if (token.startsWith('</')) depth--
    else if (!token.endsWith('/>')) depth++
    if (depth === 0) return html.slice(start, tags.lastIndex)
    if (tags.lastIndex - start > fallbackLength) break
  }
  return html.slice(start, start + fallbackLength)
}

function findElement(html: string, pattern: RegExp, fallbackLength: number) {
  const match = html.match(pattern)
  if (!match || match.index === undefined) return ''
  return extractBalancedElement(html, match.index, fallbackLength)
}

/**
 * Extract only Amazon's primary purchase price. Product pages also contain prices
 * for units, bundles, accessories, installments and carousels, so there is no
 * generic full-page price fallback: ambiguous markup must fail closed.
 */
export function extractAmazonBuyBoxPrice(html: string): number {
  const cleaned = removeScriptsAndStyles(html)
  // Prefer the primary product-price container. A separate bundle widget can also
  // use priceToPay, so a page-wide first match is not sufficient evidence.
  const core = findElement(
    cleaned,
    /<(?:div|span)\b[^>]*id="(?:corePriceDisplay_desktop_feature_div|corePrice_feature_div|apex_desktop)"[^>]*>/i,
    12_000
  )
  if (core) {
    const node = findElement(core, /<(?:span|div)\b[^>]*class="[^"]*\bpriceToPay\b[^"]*"[^>]*>/i, 2_000)
    // The core container may also hold basis/list/unit prices. If Amazon does
    // not expose the trusted current-price node, fail closed.
    const price = node ? parsePriceFromScope(node) : 0
    if (price > 0) return price
  }

  const dedicatedAnchors = [
    /<(?:span|div)\b[^>]*id="price_inside_buybox"[^>]*>/i,
    /<(?:span|div)\b[^>]*id="newBuyBoxPrice"[^>]*>/i,
    /<(?:span|div)\b[^>]*id="priceblock_ourprice"[^>]*>/i,
    /<(?:span|div)\b[^>]*id="priceblock_dealprice"[^>]*>/i,
  ]

  for (const anchor of dedicatedAnchors) {
    const node = findElement(cleaned, anchor, 2_000)
    const price = parsePriceFromScope(node)
    if (price > 0) return price
  }

  return 0
}

/** Limit stock and fulfillment interpretation to the product purchase area. */
export function extractAmazonPurchaseScope(html: string): string {
  const cleaned = removeScriptsAndStyles(html)
  const anchors: Array<[RegExp, number]> = [
    [/<(?:div|span)\b[^>]*id="desktop_buybox"[^>]*>/i, 10_000],
    [/<(?:div|span)\b[^>]*id="buybox"[^>]*>/i, 10_000],
    [/<(?:div|span)\b[^>]*id="deliveryBlockMessage"[^>]*>/i, 4_000],
    [/<(?:div|span)\b[^>]*id="mir-layout-DELIVERY_BLOCK"[^>]*>/i, 5_000],
    [/<(?:span|div)\b[^>]*class="[^"]*\bpriceToPay\b[^"]*"[^>]*>/i, 2_000],
    [/<(?:input|button)\b[^>]*(?:id="add-to-cart-button"|name="submit\.add-to-cart")[^>]*>/i, 500],
    [/<(?:input|button)\b[^>]*(?:id="buy-now-button"|name="submit\.buy-now")[^>]*>/i, 500],
  ]
  const scopes: string[] = []
  for (const [anchor, length] of anchors) {
    const node = findElement(cleaned, anchor, length)
    if (node) scopes.push(node)
  }
  return scopes.join('\n')
}

export function extractAmazonAvailabilityScope(html: string): string {
  const cleaned = removeScriptsAndStyles(html)
  return findElement(cleaned, /<(?:div|span)\b[^>]*id="availability"[^>]*>/i, 3_000)
}
