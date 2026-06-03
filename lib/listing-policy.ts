export type ListingPolicySeverity = 'block' | 'review'

export type ListingPolicyFlag = {
  code: string
  severity: ListingPolicySeverity
  reason: string
  match?: string
}

type ListingPolicyInput = {
  title?: string | null
  description?: string | null
  niche?: string | null
  categoryName?: string | null
}

type PolicyRule = {
  code: string
  reason: string
  pattern: RegExp
  severity?: ListingPolicySeverity
  allowAccessoryContext?: boolean
}

const ACCESSORY_WORDS = /\b(accessor(?:y|ies)|adapter|case|cover|protector|screen protector|tempered glass|charger|charging|cable|cord|mount|holder|stand|dock|strap|band|sleeve|skin|grip|thumb cap|replacement|compatible|fits|for|storage|binder|display case|organizer|wallet|lens protector)\b/i
const COMPATIBILITY_WORDS = /\b(for|fits|compatible with|designed for|works with|replacement for)\b/i

const COUNTERFEIT_RULES: PolicyRule[] = [
  { code: 'counterfeit_language', reason: 'Counterfeit, replica, or knockoff language is not allowed for automated listing.', pattern: /\b(replica|counterfeit|fake|knockoff|bootleg|unauthorized|mirror quality|1\s*:\s*1)\b/i },
  { code: 'brand_inspired_language', reason: 'Brand-inspired wording is high risk for intellectual property claims.', pattern: /\b(inspired by|look\s*alike|dupe|designer style|designer inspired)\b/i },
]

const HIGH_RISK_BRAND_RULES: PolicyRule[] = [
  // NOTE: "off-?white" was removed 2026-06-03 — too many false positives on the
  // color "off-white" in furniture, paint, clothing, etc. Off-White brand listings
  // are rare enough that blocking thousands of valid items wasn't worth catching them.
  { code: 'luxury_brand', reason: 'Luxury and designer brands are blocked from automated listing because of VeRO risk.', pattern: /\b(louis vuitton|lv bag|gucci|chanel|prada|burberry|versace|fendi|christian dior|dior|yves saint laurent|saint laurent|ysl|hermes|balenciaga|givenchy|bottega veneta|celine|valentino|supreme box logo)\b/i },
  { code: 'watch_brand', reason: 'Luxury watch brands are blocked from automated listing because of VeRO risk.', pattern: /\b(rolex|omega watch|patek philippe|audemars piguet|hublot|cartier watch|breitling|tag heuer|iwc schaffhausen)\b/i },
  { code: 'eyewear_brand', reason: 'High-risk branded eyewear is blocked from automated listing.', pattern: /\b(ray-?ban|oakley sunglasses?)\b/i },
  { code: 'outerwear_brand', reason: 'High-risk branded outerwear is blocked from automated listing.', pattern: /\b(canada goose|moncler|ugg boots?)\b/i },
  { code: 'toy_ip_brand', reason: 'High-risk toy and entertainment IP products are blocked unless they are clearly only accessories.', pattern: /\b(lego|disney|marvel|star wars|harry potter|pokemon|nintendo|mario|barbie|hot wheels|funko pop)\b/i, allowAccessoryContext: true },
  { code: 'amazon_brand', reason: 'Amazon-owned brands/devices are blocked from automated cross-listing.', pattern: /\b(amazon basics|amazonbasics|amazon essentials|kindle|echo dot|fire tv|ring video doorbell|blink camera)\b/i },
  { code: 'major_device_brand', reason: 'Major branded devices are blocked unless the product is clearly an accessory or replacement part.', pattern: /\b(apple iphone|iphone|ipad|macbook|airpods|dyson|playstation 5|ps5 console|xbox series|meta quest|oculus quest)\b/i, allowAccessoryContext: true },
]

const RESTRICTED_ITEM_RULES: PolicyRule[] = [
  { code: 'weapons_restricted', reason: 'Weapons, ammunition, and related regulated items are blocked.', pattern: /\b(firearm|rifle|pistol|ammunition|ammo|airsoft gun|bb gun|pellet gun|taser|stun gun|brass knuckles|switchblade|butterfly knife|throwing knives|combat knife)\b/i },
  { code: 'drugs_restricted', reason: 'Controlled substances, nicotine, and regulated drugs are blocked from automated listing.', pattern: /\b(prescription|rx only|controlled substance|nicotine|vape|e-?cig|tobacco|cigar|cannabis|cbd|thc|kratom|ozempic|insulin|testosterone|steroid)\b/i },
  { code: 'medical_restricted', reason: 'High-risk medical supplies and diagnostic products are blocked from automated listing.', pattern: /\b(syringe|hypodermic|needle|lancet|blood glucose test strips|covid(?:-19)? test|rapid test|pregnancy test|hiv test|medical oxygen|oxygen concentrator|hearing aid)\b/i },
  { code: 'hazardous_restricted', reason: 'Hazardous, pesticide, or safety-sensitive products are blocked from automated listing.', pattern: /\b(pesticide|insecticide|repellent|mosquito|bug\s+spray|bug\s+zapper|citronella|pest\s+control|rodent\s+control|ant\s+killer|roach\s+killer|wasp\s+spray|termite|flea\s+and\s+tick|rat poison|fire extinguisher|recalled|drop-side crib|crib bumper|infant inclined sleeper|hoverboard)\b/i },
  { code: 'currency_restricted', reason: 'Currency and counterfeit-adjacent products are blocked unless they are clearly collecting supplies.', pattern: /\b(counterfeit money|prop money|fake money|replica coin|copy coin|currency detector pen)\b/i },
]

const HIGH_RETURN_OPERATIONAL_RULES: PolicyRule[] = [
  { code: 'oversized_or_high_return_item', reason: 'Oversized, fragile, or high-return items are blocked for automated drop-shipping workflows.', pattern: /\b(treadmill|elliptical|mattress|sofa|couch|television|computer monitor|gaming monitor|pc monitor|generator|chainsaw|pressure washer|e-bike|electric bike|rc plane|rc airplane|drone)\b/i },
  { code: 'standalone_computer_or_tablet', reason: 'Standalone computers/tablets are blocked; accessories are allowed when clearly described as accessories.', pattern: /\b(laptop|tablet)\b/i, allowAccessoryContext: true },
]

const MARKETPLACE_COPY_RULES: PolicyRule[] = [
  { code: 'marketplace_badge_language', reason: 'Marketplace badges or seller claims must not be copied into eBay listings.', pattern: /\b(amazon'?s choice|overall pick|#?\s*1\s*best seller|limited time deal|climate pledge friendly|fulfilled by amazon|ships from amazon|sold by amazon|prime eligible|prime shipping)\b/i },
]

function normalizePolicyText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9:.\-\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasAccessoryContext(text: string) {
  return ACCESSORY_WORDS.test(text) || COMPATIBILITY_WORDS.test(text)
}

function pushRuleFlag(flags: ListingPolicyFlag[], rule: PolicyRule, text: string) {
  if (rule.allowAccessoryContext && hasAccessoryContext(text)) return
  const match = text.match(rule.pattern)?.[0]
  if (!match) return
  flags.push({
    code: rule.code,
    severity: rule.severity || 'block',
    reason: rule.reason,
    match,
  })
}

function isSupplyOnlyCurrencyProduct(text: string) {
  return /\b(coin holder|coin album|coin capsule|coin tubes|currency album|currency sleeves|collection supplies|magnifying glass|jeweler loupe)\b/i.test(text)
}

export function getListingPolicyFlags(input: ListingPolicyInput): ListingPolicyFlag[] {
  const text = normalizePolicyText([
    input.title,
    input.description,
    input.niche,
    input.categoryName,
  ].filter(Boolean).join(' '))

  if (!text) return []

  const flags: ListingPolicyFlag[] = []
  const rules = [
    ...COUNTERFEIT_RULES,
    ...HIGH_RISK_BRAND_RULES,
    ...RESTRICTED_ITEM_RULES,
    ...HIGH_RETURN_OPERATIONAL_RULES,
    ...MARKETPLACE_COPY_RULES,
  ]

  for (const rule of rules) {
    if (rule.code === 'currency_restricted' && isSupplyOnlyCurrencyProduct(text)) continue
    pushRuleFlag(flags, rule, text)
  }

  const seen = new Set<string>()
  return flags.filter((flag) => {
    const key = `${flag.code}:${flag.match || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function hasBlockedListingPolicyFlag(flags: ListingPolicyFlag[]) {
  return flags.some((flag) => flag.severity === 'block')
}

export function getListingPolicyBlockReason(flags: ListingPolicyFlag[]) {
  const flag = flags.find((entry) => entry.severity === 'block')
  if (!flag) return 'This product needs manual review before listing.'
  return `${flag.reason}${flag.match ? ` Matched: ${flag.match}.` : ''}`
}

export function isBlockedByListingPolicy(input: ListingPolicyInput) {
  return hasBlockedListingPolicyFlag(getListingPolicyFlags(input))
}
