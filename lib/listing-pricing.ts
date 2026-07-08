export const EBAY_DEFAULT_FEE_RATE = 0.136
export const EBAY_DEFAULT_FIXED_FEE = 0.4
export const EBAY_LOW_ORDER_FIXED_FEE = 0.3
export const EBAY_LOW_ORDER_THRESHOLD = 10
export const PRICING_BUFFER_RATE = 0.015
export const MIN_HEALTHY_PROFIT = 7
export const MIN_HEALTHY_ROI = 28
export const MIN_HEALTHY_MARGIN = 15

// TRUE-NET-PROFIT safeguard (added 2026-06-07 after a $13 camera netted $0.57).
// The older floors used GROSS margin (e.g. "Amazon + $4") which ignored Promoted
// Listings ad fees and the sales tax we pay buying on Amazon. These constants let
// us compute the REAL take-home and block listings that can't clear it.
export const PROMOTED_AD_RATE = Number(process.env.PROMOTED_AD_RATE || '0.06')
export const AMAZON_SOURCE_TAX_RATE = Number(process.env.AMAZON_SOURCE_TAX_RATE || '0.07')
export const MIN_NET_PROFIT = Number(process.env.MIN_NET_PROFIT || '5')

type PricingConfidence = 'none' | 'low' | 'medium' | 'high'
type PricingStrategy = 'cost_floor' | 'balanced' | 'competitive' | 'not_viable'

export type PricingMarketSignal = {
  competitorPrices?: number[]
  competitorCount?: number
  competitorLow?: number | null
  competitorMedian?: number | null
  competitorP25?: number | null
}

export type PricingRecommendationInput = PricingMarketSignal & {
  amazonPrice: number
  feeRate?: number
  fixedFee?: number
  bufferRate?: number
  risk?: string
  demandScore?: number
}

export type PricingRecommendation = {
  price: number
  minimumViablePrice: number
  targetPrice: number
  amazonPrice: number
  targetProfit: number
  minimumProfit: number
  targetRoi: number
  fees: number
  profit: number
  roi: number
  margin: number
  variableFee: number
  fixedFee: number
  bufferCost: number
  competitorLow: number | null
  competitorMedian: number | null
  competitorP25: number | null
  competitorCeiling: number | null
  competitorCount: number
  confidence: PricingConfidence
  strategy: PricingStrategy
  viable: boolean
  reason: string
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function money(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return null
  const index = clamp((sorted.length - 1) * ratio, 0, sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  const weight = index - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

function cleanMarketPrices(prices: unknown[], amazonPrice: number) {
  const upperBound = Math.max(amazonPrice * 5, amazonPrice + 80)
  return Array.from(
    new Set(
      prices
        .map((price) => Number(price))
        .filter((price) => Number.isFinite(price) && price > 0)
        .filter((price) => price >= Math.max(3, amazonPrice * 0.65) && price <= upperBound)
        .map((price) => money(price))
    )
  ).sort((a, b) => a - b)
}

function summarizeMarket(input: PricingMarketSignal, amazonPrice: number) {
  const prices = cleanMarketPrices(input.competitorPrices || [], amazonPrice)
  const competitorLow = input.competitorLow && input.competitorLow > 0 ? input.competitorLow : prices[0] || null
  const competitorMedian = input.competitorMedian && input.competitorMedian > 0 ? input.competitorMedian : percentile(prices, 0.5)
  const competitorP25 = input.competitorP25 && input.competitorP25 > 0 ? input.competitorP25 : percentile(prices, 0.25)
  const competitorCount = input.competitorCount || prices.length
  const confidence: PricingConfidence =
    competitorCount >= 8 ? 'high' :
    competitorCount >= 4 ? 'medium' :
    competitorCount >= 1 ? 'low' :
    'none'

  return {
    prices,
    competitorLow: competitorLow ? money(competitorLow) : null,
    competitorMedian: competitorMedian ? money(competitorMedian) : null,
    competitorP25: competitorP25 ? money(competitorP25) : null,
    competitorCount,
    confidence,
  }
}

export function getTargetRoi(amazonPrice: number, input: { risk?: string; demandScore?: number } = {}) {
  // Upper bands raised 7/8 (user: "$74 sale netted ~$5 — I want better ROI especially
  // when the eBay item is pricier"): the old targets didn't cover the 2% Promoted
  // Listings campaign + ~7% Amazon purchase tax, which eat big-ticket margins in
  // dollar terms. Competitive ceiling still caps prices at market rates.
  const base =
    amazonPrice < 8 ? 105 :
    amazonPrice < 15 ? 82 :
    amazonPrice < 25 ? 64 :
    amazonPrice < 40 ? 52 :
    amazonPrice < 75 ? 46 :
    amazonPrice < 125 ? 40 :
    amazonPrice < 200 ? 34 :
    28

  const demandScore = typeof input.demandScore === 'number' ? clamp(input.demandScore, 0, 1) : 0.5
  const demandAdjustment = (0.5 - demandScore) * 10
  const riskAdjustment = String(input.risk || '').toUpperCase() === 'HIGH' ? 8 : String(input.risk || '').toUpperCase() === 'MEDIUM' ? 4 : 0
  return money(clamp(base + demandAdjustment + riskAdjustment, 18, 120))
}

export function getMinimumProfit(amazonPrice: number) {
  if (amazonPrice < 8) return 5
  if (amazonPrice < 15) return 6.5
  if (amazonPrice < 25) return 8
  if (amazonPrice < 40) return 10
  if (amazonPrice < 75) return 15
  if (amazonPrice < 125) return Math.max(20, amazonPrice * 0.17)
  if (amazonPrice < 200) return Math.max(28, amazonPrice * 0.15)
  return Math.max(40, amazonPrice * 0.13)
}

export function getTargetProfit(amazonPrice: number, input: { risk?: string; demandScore?: number } = {}) {
  const targetByRoi = amazonPrice * (getTargetRoi(amazonPrice, input) / 100)
  const minimum = getMinimumProfit(amazonPrice)
  const maxTarget =
    amazonPrice < 20 ? amazonPrice * 1.15 :
    amazonPrice < 75 ? amazonPrice * 0.72 :
    amazonPrice < 200 ? amazonPrice * 0.46 :
    amazonPrice * 0.32
  return money(clamp(Math.max(minimum, targetByRoi), minimum, Math.max(minimum, maxTarget)))
}

function getMinimumViableProfit(amazonPrice: number) {
  const target = getTargetProfit(amazonPrice)
  const floorByRoi =
    amazonPrice < 15 ? amazonPrice * 0.45 :
    amazonPrice < 40 ? amazonPrice * 0.32 :
    amazonPrice < 100 ? amazonPrice * 0.22 :
    amazonPrice * 0.14
  return money(Math.max(getMinimumProfit(amazonPrice), Math.min(target * 0.72, floorByRoi + 4)))
}

function getFixedFeeForPrice(ebayPrice: number, override?: number) {
  if (typeof override === 'number') return override
  return ebayPrice > 0 && ebayPrice <= EBAY_LOW_ORDER_THRESHOLD
    ? EBAY_LOW_ORDER_FIXED_FEE
    : EBAY_DEFAULT_FIXED_FEE
}

function priceForProfit(amazonPrice: number, targetProfit: number, feeRate: number, fixedFee: number | undefined, bufferRate: number) {
  const variableRate = clamp(feeRate + bufferRate, 0, 0.45)
  const firstPassFixedFee = fixedFee ?? EBAY_DEFAULT_FIXED_FEE
  const firstPassPrice = (amazonPrice + firstPassFixedFee + targetProfit) / (1 - variableRate)
  const actualFixedFee = getFixedFeeForPrice(firstPassPrice, fixedFee)
  return actualFixedFee === firstPassFixedFee
    ? firstPassPrice
    : (amazonPrice + actualFixedFee + targetProfit) / (1 - variableRate)
}

function psychologicalPrice(raw: number, options: { minPrice?: number; maxPrice?: number; preferBelow?: boolean } = {}) {
  const minPrice = Math.max(0.99, options.minPrice || 0.99)
  const maxPrice = options.maxPrice && options.maxPrice > 0 ? options.maxPrice : null
  const lower = Math.max(0, Math.floor(Math.min(raw, minPrice)) - 2)
  const upper = Math.ceil(Math.max(raw, minPrice, maxPrice || raw) + 3)
  const endings = [0.99, 0.95, 0.49]
  const candidates: number[] = []

  for (let dollars = lower; dollars <= upper; dollars += 1) {
    for (const ending of endings) {
      const candidate = money(dollars + ending)
      if (candidate < minPrice) continue
      if (maxPrice !== null && candidate > maxPrice) continue
      candidates.push(candidate)
    }
  }

  if (candidates.length === 0) {
    return money(maxPrice !== null && minPrice > maxPrice ? minPrice : Math.max(minPrice, raw))
  }

  const endingRank = (price: number) => {
    const cents = Math.round((price - Math.floor(price)) * 100)
    if (cents === 99) return 0
    if (cents === 95) return 0.03
    return 0.08
  }

  candidates.sort((a, b) => {
    const aAbove = a > raw ? 1 : 0
    const bAbove = b > raw ? 1 : 0
    const abovePenalty = options.preferBelow ? (aAbove - bAbove) * 2 : 0
    return abovePenalty + Math.abs(a - raw) - Math.abs(b - raw) + endingRank(a) - endingRank(b)
  })

  return candidates[0]
}

function getCompetitiveCeiling(market: ReturnType<typeof summarizeMarket>) {
  if (!market.competitorLow && !market.competitorMedian) return null
  const low = market.competitorLow || market.competitorMedian || 0
  const p25 = market.competitorP25 || low
  const median = market.competitorMedian || p25
  const raw =
    market.confidence === 'high' ? Math.min(p25 - 0.25, median * 0.965) :
    market.confidence === 'medium' ? Math.min(p25 - 0.2, median * 0.975) :
    low - 0.15
  return raw > 0 ? money(raw) : null
}

export function getListingMetrics(
  amazonPrice: number,
  ebayPrice: number,
  feeRate = EBAY_DEFAULT_FEE_RATE,
  options: { fixedFee?: number; bufferRate?: number } = {}
) {
  const fixedFee = ebayPrice > 0 ? getFixedFeeForPrice(ebayPrice, options.fixedFee) : 0
  const bufferRate = options.bufferRate ?? PRICING_BUFFER_RATE
  const variableFee = money(ebayPrice * feeRate)
  const bufferCost = money(ebayPrice * bufferRate)
  const fees = money(variableFee + fixedFee + bufferCost)
  const profit = money(ebayPrice - amazonPrice - fees)
  const roi = amazonPrice > 0 ? money((profit / amazonPrice) * 100) : 0
  const margin = ebayPrice > 0 ? money((profit / ebayPrice) * 100) : 0
  return { fees, variableFee, fixedFee, bufferCost, profit, roi, margin }
}

/**
 * TRUE net profit (take-home) after EVERY real cost:
 *   eBay variable fee + eBay fixed fee + operating buffer
 *   + Promoted Listings ad fee (charged on sale price)
 *   + the sales tax we pay when buying the item on Amazon.
 * This is the number the min-profit safeguard checks — NOT the gross "ebay - amazon".
 */
export function getNetProfit(
  amazonPrice: number,
  ebayPrice: number,
  options: { feeRate?: number; fixedFee?: number; bufferRate?: number; promotedRate?: number; amazonTaxRate?: number } = {}
) {
  const feeRate = options.feeRate ?? EBAY_DEFAULT_FEE_RATE
  const bufferRate = options.bufferRate ?? PRICING_BUFFER_RATE
  const promotedRate = options.promotedRate ?? PROMOTED_AD_RATE
  const amazonTaxRate = options.amazonTaxRate ?? AMAZON_SOURCE_TAX_RATE
  const fixedFee = ebayPrice > 0 ? getFixedFeeForPrice(ebayPrice, options.fixedFee) : 0
  const variableFee = ebayPrice * feeRate
  const bufferCost = ebayPrice * bufferRate
  const promotedFee = ebayPrice * promotedRate
  const amazonLanded = amazonPrice * (1 + amazonTaxRate)
  return money(ebayPrice - amazonLanded - variableFee - fixedFee - bufferCost - promotedFee)
}

/** The lowest eBay price at which a product clears MIN_NET_PROFIT after all real costs. */
export function priceForNetProfit(
  amazonPrice: number,
  netProfit = MIN_NET_PROFIT,
  options: { feeRate?: number; bufferRate?: number; promotedRate?: number; amazonTaxRate?: number } = {}
) {
  const feeRate = options.feeRate ?? EBAY_DEFAULT_FEE_RATE
  const bufferRate = options.bufferRate ?? PRICING_BUFFER_RATE
  const promotedRate = options.promotedRate ?? PROMOTED_AD_RATE
  const amazonTaxRate = options.amazonTaxRate ?? AMAZON_SOURCE_TAX_RATE
  const variableRate = clamp(feeRate + bufferRate + promotedRate, 0, 0.6)
  const amazonLanded = amazonPrice * (1 + amazonTaxRate)
  // Try low-order fixed fee first, then standard if the resulting price crosses the threshold.
  const lowPass = (amazonLanded + EBAY_LOW_ORDER_FIXED_FEE + netProfit) / (1 - variableRate)
  if (lowPass <= EBAY_LOW_ORDER_THRESHOLD) return money(lowPass)
  return money((amazonLanded + EBAY_DEFAULT_FIXED_FEE + netProfit) / (1 - variableRate))
}

export function getPricingRecommendation(input: PricingRecommendationInput): PricingRecommendation {
  const amazonPrice = Math.max(0, Number(input.amazonPrice) || 0)
  const feeRate = input.feeRate ?? EBAY_DEFAULT_FEE_RATE
  const fixedFee = input.fixedFee
  const bufferRate = input.bufferRate ?? PRICING_BUFFER_RATE
  const targetRoi = getTargetRoi(amazonPrice, input)
  const targetProfit = getTargetProfit(amazonPrice, input)
  const minimumProfit = getMinimumViableProfit(amazonPrice)
  const minimumViableRaw = priceForProfit(amazonPrice, minimumProfit, feeRate, fixedFee, bufferRate)
  const targetRaw = priceForProfit(amazonPrice, targetProfit, feeRate, fixedFee, bufferRate)
  const minimumViablePrice = psychologicalPrice(minimumViableRaw, { minPrice: minimumViableRaw })
  const targetPrice = psychologicalPrice(targetRaw, { minPrice: minimumViablePrice })
  const market = summarizeMarket(input, amazonPrice)
  const competitorCeiling = getCompetitiveCeiling(market)
  const marketViable = competitorCeiling === null || competitorCeiling >= minimumViablePrice

  let strategy: PricingStrategy = 'balanced'
  let rawPrice = targetPrice
  let maxPrice: number | undefined
  let reason = 'Priced from Amazon cost, dynamic ROI target, eBay fee, fixed fee, and operating buffer.'

  if (competitorCeiling !== null) {
    if (marketViable) {
      rawPrice = Math.min(targetPrice, competitorCeiling)
      maxPrice = competitorCeiling
      strategy = rawPrice < targetPrice ? 'competitive' : 'balanced'
      reason = 'Priced to stay under comparable eBay listings while preserving the profit floor.'
    } else {
      rawPrice = minimumViablePrice
      strategy = 'not_viable'
      reason = 'Comparable eBay prices are below the minimum profitable price.'
    }
  } else if (targetPrice <= minimumViablePrice + 0.5) {
    strategy = 'cost_floor'
  }

  const price = psychologicalPrice(rawPrice, {
    minPrice: minimumViablePrice,
    maxPrice: maxPrice && maxPrice >= minimumViablePrice ? maxPrice : undefined,
    preferBelow: strategy === 'competitive',
  })
  const metrics = getListingMetrics(amazonPrice, price, feeRate, { fixedFee, bufferRate })

  return {
    price,
    minimumViablePrice,
    targetPrice,
    amazonPrice,
    targetProfit,
    minimumProfit,
    targetRoi,
    ...metrics,
    competitorLow: market.competitorLow,
    competitorMedian: market.competitorMedian,
    competitorP25: market.competitorP25,
    competitorCeiling,
    competitorCount: market.competitorCount,
    confidence: market.confidence,
    strategy,
    viable: marketViable,
    reason,
  }
}

export function getRecommendedEbayPrice(
  amazonPrice: number,
  feeRate = EBAY_DEFAULT_FEE_RATE,
  options: Omit<PricingRecommendationInput, 'amazonPrice' | 'feeRate'> = {}
) {
  return getPricingRecommendation({ amazonPrice, feeRate, ...options }).price
}

export function isHealthyListing(amazonPrice: number, ebayPrice: number, feeRate = EBAY_DEFAULT_FEE_RATE) {
  const metrics = getListingMetrics(amazonPrice, ebayPrice, feeRate)
  const minimumProfit = getMinimumViableProfit(amazonPrice)
  const minimumRoi = Math.max(MIN_HEALTHY_ROI, getTargetRoi(amazonPrice) * 0.62)
  return (
    metrics.profit >= Math.max(MIN_HEALTHY_PROFIT, minimumProfit) &&
    metrics.roi >= minimumRoi &&
    metrics.margin >= MIN_HEALTHY_MARGIN
  )
}
