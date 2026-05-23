export type Tab = 'overview' | 'orders' | 'fulfillment' | 'financials' | 'performance' | 'scripts' | 'asin' | 'product' | 'continuous' | 'campaigns' | 'settings' | 'more'

export interface EbayShipToAddress {
  fullName?: string
  contactAddress?: {
    addressLine1?: string
    addressLine2?: string
    city?: string
    stateOrProvince?: string
    postalCode?: string
    countryCode?: string
  }
  primaryPhone?: {
    phoneNumber?: string
  }
  email?: string
}

export interface AsinResult {
  asin: string
  title: string
  amazonPrice: number
  imageUrl?: string
  images?: string[]
  features?: string[]
  description?: string
  specs?: Array<[string, string]>
  available: boolean
  amazonUrl?: string
  ebayTitle?: string
  confidence?: 'exact' | 'manual' | 'recovered' | 'search'
  source: 'api' | 'manual' | 'db' | 'search' | 'scrape' | 'cache' | 'fallback'
}

export interface EbayOrder {
  orderId: string
  buyer: { username: string }
  pricingSummary: { total: { value: string; currency: string } }
  paymentSummary?: {
    refunds?: Array<{
      refundStatus?: string
      amount?: { value?: string; currency?: string }
    }>
  }
  cancelStatus?: {
    cancelState?: string
  }
  fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: EbayShipToAddress } }>
  lineItems?: Array<{
    title: string
    quantity: number
    lineItemCost: { value: string }
    sku?: string
    legacyItemId?: string
    refunds?: Array<{
      refundStatus?: string
      amount?: { value?: string; currency?: string }
    }>
  }>
  orderFulfillmentStatus: string
  orderPaymentStatus?: string
  creationDate: string
}

export interface FinderProduct {
  asin: string
  title: string
  amazonPrice: number
  ebayPrice: number
  profit: number
  roi: number
  imageUrl?: string
  images?: string[]
  features?: string[]
  description?: string
  specs?: Array<[string, string]>
  risk: string
  salesVolume?: string
  sourceNiche?: string
  sourceMode?: 'niche' | 'continuous'
  qualityScore?: number
  available?: boolean
}

export interface ListResult {
  listingUrl: string
  listingId: string
  subscription?: {
    plan: string
    trialLimit: number
    listed: number
    trialRemaining: number
  }
}

export interface FinancialSummary {
  grossRevenue: number
  grossSalesRevenue?: number
  refundedRevenue?: number
  trackedRevenue: number
  amazonCost: number
  ebayFees: number
  profit: number
  roi: number
  margin: number
  soldItems: number
  refundedItems?: number
  trackedItems: number
  missingCostItems: number
  actualFeeItems?: number
  estimatedFeeItems?: number
  financeApiAvailable?: boolean
  financeApiStatus?: number | null
}

export interface FinancialItem {
  id: string
  orderId: string
  listingId: string | null
  asin: string | null
  title: string
  soldAt: string
  quantity: number
  grossRevenue?: number
  ebayRevenue: number
  refundedAmount?: number
  refundStatus?: 'none' | 'partial' | 'full' | 'pending'
  amazonUnitCost: number | null
  amazonCost: number | null
  ebayFeeRate: number
  ebayFees: number
  feeSource?: 'actual' | 'estimated'
  profit: number | null
  roi: number | null
  margin: number | null
  hasTrackedCost: boolean
}

export interface PerformanceNiche {
  name: string
  revenue: number
  profit: number
  soldUnits: number
  listings: number
  activeListings: number
  views: number
  watchers: number
  impressions: number
  conversionRate: number | null
  roi: number
  margin: number
  sellThrough: number
  avgProfitPerSale: number
  score: number
  action: string
  tone: string
  summary: string
  reasons: string[]
}

export interface PerformanceProduct {
  listingId: string
  asin: string | null
  title: string
  niche: string
  categoryName: string | null
  revenue: number
  profit: number
  roi: number
  margin: number
  soldUnits: number
  views: number
  watchers: number
  impressions: number
  conversionRate: number | null
  listedAt: string | null
  active: boolean
  score: number
  action: string
}

export interface PerformanceData {
  connected: boolean
  generatedAt?: string
  windowDays?: number
  traffic: {
    available: boolean
    error: string | null
    watcherSignalsAvailable?: boolean
    watcherError?: string | null
  }
  summary: {
    bestNiche: string | null
    avoidNiche: string | null
    totalRevenue: number
    totalProfit: number
    soldUnits: number
    activeListings: number
    views: number
    watchers: number
  } | null
  niches: PerformanceNiche[]
  products: PerformanceProduct[]
}

export interface ProductSourceHealth {
  generatedAt: string
  status: 'healthy' | 'watch' | 'attention'
  warnings: string[]
  sourceEngine: {
    totalProducts: number
    niches: number
    staleProducts: number
    missingImages: number
    highRiskProducts: number
    averageScore: number
    newestSeenAt: string | null
  }
  cache: {
    totalNiches: number
    readyNiches: number
    staleNiches: number
    totalProducts: number
  }
  continuous: {
    products: number
    version: number
    cachedAt: string | null
  }
  topNiches: Array<{
    name: string
    count: number
    averageScore: number
    maxScore: number
    newestSeenAt: string | null
  }>
  providers: {
    rapidApiConfigured: boolean
    liveProviderChecks: string
  }
}

export interface ListProgress {
  done: number
  total: number
  errors: number
  skipped?: number
  failures?: BulkListFailure[]
}

export interface BulkListFailure {
  asin: string
  title: string
  code: string
  message: string
  skipped?: boolean
}

export interface BannerState {
  tone: 'success' | 'error'
  text: string
}

export interface EbayCredentialsSummary {
  has_token?: boolean
  has_refresh_token?: boolean
  token_expired?: boolean
  sandbox_mode?: boolean
}

export interface ScriptMessage {
  file: string
  tone: 'success' | 'error' | 'info'
  text: string
}

export type OrderAsinMap = Record<string, { asin: string; title: string; amazonUrl?: string; imageUrl?: string; confidence?: 'manual' | 'exact' | 'recovered' | 'search' }>
