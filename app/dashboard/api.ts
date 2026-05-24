import type { AsinResult, EbayCredentialsSummary, EbayOrder, FinancialItem, FinancialSummary, FinderProduct, ListResult, OrderAsinMap, PerformanceData, ProductSourceHealth } from './types'

export class DashboardApiError extends Error {
  code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'DashboardApiError'
    this.code = code
  }
}

async function requestJson<T>(input: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { timeoutMs, ...requestInit } = init || {}
  const controller = timeoutMs ? new AbortController() : null
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null

  let response: Response
  try {
    response = await fetch(input, controller ? { ...requestInit, signal: controller.signal } : requestInit)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DashboardApiError('Product search is taking too long. Try again in a moment while the product pool warms up.', 'REQUEST_TIMEOUT')
    }
    throw error
  } finally {
    if (timeout) window.clearTimeout(timeout)
  }

  const data = await response.json().catch(() => null)

  if (data?.ok === false && data?.error) {
    throw new DashboardApiError(data.error.message || 'Request failed.', data.error.code)
  }

  if (!response.ok) {
    const code = data?.error?.code || data?.code || data?.error
    const message = data?.error?.message || data?.error || data?.message || `Request failed (${response.status})`
    throw new DashboardApiError(message, code)
  }

  if (data?.error) {
    const code = typeof data.error === 'string' ? data.error : data.error?.code
    const message = typeof data.error === 'string' ? data.error : data.error?.message || 'Request failed.'
    throw new DashboardApiError(message, code)
  }

  return data as T
}

export function isReconnectError(error: unknown) {
  return error instanceof DashboardApiError && error.code === 'RECONNECT_REQUIRED'
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof DashboardApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export async function fetchOrders() {
  return requestJson<{ ok: true; connected: boolean; recent?: EbayOrder[]; awaiting?: EbayOrder[] }>('/api/ebay/orders')
}

export async function fetchFinancials(period = '30d') {
  return requestJson<{ ok: true; connected: boolean; summary: FinancialSummary; items: FinancialItem[] }>(`/api/financials?period=${period}`)
}

export async function fetchPerformance() {
  return requestJson<PerformanceData & { ok: true }>('/api/performance')
}

export async function fetchProductSourceHealth() {
  return requestJson<ProductSourceHealth & { ok: true }>('/api/product-source/health')
}

export async function fetchEbayCredentials() {
  return requestJson<{ ok: true; credentials: EbayCredentialsSummary | null }>('/api/ebay/credentials')
}

export type EbayQuotaRule = {
  callName: string
  dailyHardLimit: number
  dailyUsage: number
  dailyRemaining: number | null
  hourlyHardLimit: number
  hourlyUsage: number
  hourlyRemaining: number | null
  dailyPercent: number | null
  hourlyPercent: number | null
}

export async function fetchEbayQuotaStatus() {
  return requestJson<{
    ok: true
    nearLimit: boolean
    exhausted: boolean
    resetEstimateIso: string
    limitingRules: EbayQuotaRule[]
    activeRules: EbayQuotaRule[]
    rulesCount: number
  }>('/api/ebay/quota', { cache: 'no-store', timeoutMs: 12000 })
}

export async function disconnectEbay() {
  return requestJson<{ ok: true; success: true }>('/api/ebay/credentials', {
    method: 'DELETE',
  })
}

export async function fetchUserNiche() {
  return requestJson<{ ok: true; niche: string | null }>('/api/user/niche')
}

export async function saveUserNiche(niche: string) {
  return requestJson<{ ok: true; success: true; niche: string }>('/api/user/niche', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ niche }),
  })
}

export async function fetchAmazonCredentials() {
  return requestJson<{ ok: true; connected: boolean; sellingPartnerId?: string }>('/api/amazon/credentials')
}

export async function fetchOrderAsinMap() {
  return requestJson<{ ok: true; map: OrderAsinMap }>('/api/amazon/order-asins')
}

export async function lookupAsinByItemId(itemId: string, excludeAsins: string[] = []) {
  const params = new URLSearchParams({ itemId })
  if (excludeAsins.length > 0) params.set('exclude', excludeAsins.join(','))
  return requestJson<AsinResult>(`/api/fulfillment/lookup?${params.toString()}`)
}

export async function saveManualAsinMapping(itemId: string, asin: string) {
  return requestJson<AsinResult>('/api/fulfillment/manual-map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, asin }),
  })
}

export async function validateAmazonAsin(asin: string) {
  return requestJson<AsinResult>(`/api/amazon/lookup?asin=${encodeURIComponent(asin)}`)
}

export type FulfillmentStatusRow = {
  order_id: string
  legacy_item_id: string | null
  state: string
  last_error: string | null
  updated_at: string
}

export async function fetchFulfillmentStatuses(orderIds: string[]) {
  if (orderIds.length === 0) return { rows: [] as FulfillmentStatusRow[] }
  const params = new URLSearchParams({ orderIds: orderIds.join(',') })
  return requestJson<{ ok: true; rows: FulfillmentStatusRow[] }>(
    `/api/fulfillment/status?${params.toString()}`,
    { cache: 'no-store' }
  )
}

export async function startFulfillment(input: {
  orderId: string
  legacyItemId?: string | null
  asin?: string | null
  amazonUrl: string
  shipTo: unknown
}) {
  return requestJson<{
    ok: true
    orderId: string
    legacyItemId?: string | null
    fulfillUrl: string
    fulfillToken: string
    stackpilotOrigin: string
    jobId?: string
  }>('/api/fulfillment/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function postFulfillmentStatus(input: {
  token?: string
  orderId?: string
  legacyItemId?: string | null
  state: 'NOT_STARTED' | 'PREFILLED' | 'PURCHASED' | 'ISSUE'
  lastError?: string | null
}) {
  return requestJson<{ ok: true; state: string }>('/api/fulfillment/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function runDashboardScript(file: string) {
  return requestJson<{ ok: true; message?: string }>(`/api/scripts/run?script=${file}`)
}

export async function fetchFinderProducts(
  niche: string,
  refresh = false,
  options: { mode?: 'continuous'; limit?: number; excludeAsins?: string[] } = {}
) {
  const params = new URLSearchParams()
  if (niche) params.set('niche', niche)
  if (options.mode) params.set('mode', options.mode)
  if (options.limit) params.set('limit', String(options.limit))
  if (options.excludeAsins?.length) params.set('exclude', options.excludeAsins.join(','))
  if (refresh) params.set('refresh', '1')
  console.info('[fetchFinderProducts]', { niche: niche || '(continuous)', refresh, mode: options.mode, limit: options.limit, excludeCount: options.excludeAsins?.length ?? 0 })
  const result = await requestJson<{ ok: true; results: FinderProduct[]; available?: number; source?: string; mode?: 'niche' | 'continuous' }>(`/api/scripts/product-finder?${params.toString()}`)
  console.info('[fetchFinderProducts] response', { count: result.results?.length ?? 0, available: result.available, source: result.source })
  return result
}

export async function publishProduct(input: {
  asin: string
  title: string
  ebayPrice: number
  amazonPrice: number
  imageUrl?: string
  images?: string[]
  features?: string[]
  description?: string
  specs?: Array<[string, string]>
  niche: string | null
  trusted?: boolean
  categoryId?: string
}) {
  return requestJson<ListResult>('/api/ebay/list-product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function fetchSubscriptionStatus() {
  return requestJson<{
    ok: true
    plan: string
    status: string
    trialLimit: number
    listed: number
    trialRemaining: number
    isPro: boolean
    billing: { checkoutAvailable: boolean; portalAvailable: boolean; ownerBillingBypass?: boolean }
  }>('/api/subscription/status', { cache: 'no-store' })
}

export async function createStripeCheckoutSession() {
  return requestJson<{ ok: true; url: string }>('/api/stripe/checkout', { method: 'POST' })
}

export async function createStripePortalSession() {
  return requestJson<{ ok: true; url: string }>('/api/stripe/portal', { method: 'POST' })
}

type AutoListingMode = 'safe' | 'balanced' | 'aggressive'
export type AutoListingSettingsDto = {
  enabled: boolean
  paused: boolean
  emergency_stopped: boolean
  listings_per_day: number
  max_per_hour: number
  cooldown_minutes: number
  selected_account_id: number | null
  allowed_niches: string[]
  min_roi: number
  mode: AutoListingMode
  updated_at?: string
}

export async function fetchAutoListingSettings() {
  return requestJson<{ ok: true; settings: AutoListingSettingsDto }>('/api/auto-listing/settings', { cache: 'no-store' })
}

export async function saveAutoListingSettings(input: Partial<AutoListingSettingsDto>) {
  return requestJson<{ ok: true; settings: AutoListingSettingsDto }>('/api/auto-listing/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function fetchAutoListingStatus() {
  return requestJson<{
    ok: true
    enabled: boolean
    paused: boolean
    emergency_stopped: boolean
    postedToday: number
    queue: { queued: number; processing: number; retry: number; failed: number; completed: number }
    avgScore: number
    estimatedDailyProfit: number
  }>('/api/auto-listing/status', { cache: 'no-store' })
}

export async function fetchEbayAccounts() {
  return requestJson<{ ok: true; accounts: Array<{ id: number; label: string; sandbox_mode: boolean; active: boolean; updated_at: string }> }>('/api/ebay/accounts', { cache: 'no-store' })
}
