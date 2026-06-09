import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk, getErrorText } from '@/lib/api-response'
import { EbayNetworkError, EbayReconnectRequiredError, getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows, sql } from '@/lib/db'
import { ensureListedAsinsFinancialColumns } from '@/lib/listed-asins'
import { scrapeAmazonProduct } from '@/lib/amazon-scrape'
import { recoverAmazonProductByItemId } from '@/lib/amazon-mapping'
import { getRapidApiKey } from '@/lib/rapidapi'
import {
  AMAZON_SOURCE_TAX_RATE,
  EBAY_DEFAULT_FEE_RATE,
  EBAY_DEFAULT_FIXED_FEE,
  EBAY_LOW_ORDER_FIXED_FEE,
  EBAY_LOW_ORDER_THRESHOLD,
  PRICING_BUFFER_RATE,
  PROMOTED_AD_RATE,
} from '@/lib/listing-pricing'

function getFixedFee(ebayPrice: number) {
  return ebayPrice > 0 && ebayPrice <= EBAY_LOW_ORDER_THRESHOLD
    ? EBAY_LOW_ORDER_FIXED_FEE
    : EBAY_DEFAULT_FIXED_FEE
}

// Live-fetch Amazon price for a single ASIN and persist it to the DB.
async function resolveAmazonPrice(asin: string, userId: string): Promise<number | null> {
  try {
    const rapidKey = getRapidApiKey()
    // Optional external API fallback. By default StackPilot uses direct scraping.
    if (rapidKey) {
      const res = await fetch(
        `https://real-time-amazon-data.p.rapidapi.com/product-details?asin=${asin}&country=US`,
        { headers: { 'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com', 'x-rapidapi-key': rapidKey }, signal: AbortSignal.timeout(6000) }
      )
      if (res.ok) {
        const json = await res.json()
        const data = json?.data ?? json
        const msg = String(data?.message || '').toLowerCase()
        if (!msg.match(/limit|quota|exceed/)) {
          const raw = data.product_price || data.price
          const price = typeof raw === 'number' ? raw : parseFloat(String(raw || '').replace(/[^0-9.]/g, ''))
          if (price > 0) {
            await sql`UPDATE listed_asins SET amazon_price = ${price} WHERE user_id = ${userId} AND asin = ${asin}`.catch(() => {})
            return price
          }
        }
      }
    }
    // Fallback: scrape Amazon product page
    const scraped = await scrapeAmazonProduct(asin)
    if (scraped && scraped.price > 0) {
      await sql`UPDATE listed_asins SET amazon_price = ${scraped.price} WHERE user_id = ${userId} AND asin = ${asin}`.catch(() => {})
      return scraped.price
    }
  } catch { /* ignore */ }
  return null
}

type EbayOrder = {
  orderId: string
  creationDate: string
  orderPaymentStatus?: string
  cancelStatus?: { cancelState?: string }
  paymentSummary?: {
    refunds?: Array<{ refundStatus?: string; amount?: { value?: string } }>
  }
  pricingSummary?: { total?: { value?: string } }
  lineItems?: Array<{
    lineItemId?: string
    title?: string
    quantity?: number
    lineItemCost?: { value?: string }
    legacyItemId?: string
    refunds?: Array<{ refundStatus?: string; amount?: { value?: string } }>
  }>
}

type EbayTransaction = {
  orderId?: string
  totalFeeAmount?: { value?: string }
  orderLineItems?: Array<{
    lineItemId?: string
    feeBasisAmount?: { value?: string }
    marketplaceFees?: Array<{ amount?: { value?: string } }>
  }>
}

type EbayOrdersPayload = {
  orders?: EbayOrder[]
  total?: number
}

type ListedAsinRow = {
  asin?: string
  title?: string
  ebay_listing_id?: string
  amazon_price?: string | number | null
  ebay_price?: string | number | null
  ebay_fee_rate?: string | number | null
}

function parseMoney(value: unknown) {
  const amount = parseFloat(String(value || '0').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(amount) ? amount : 0
}

function getRefundStatus(statuses: string[], refundedAmount: number, grossRevenue: number): 'none' | 'partial' | 'full' | 'pending' {
  const normalized = statuses.map((status) => status.toUpperCase()).filter(Boolean)
  if (normalized.includes('FULLY_REFUNDED')) return 'full'
  if (grossRevenue > 0 && refundedAmount >= grossRevenue * 0.95) return 'full'
  if (normalized.includes('PARTIALLY_REFUNDED') || refundedAmount > 0) return 'partial'
  if (normalized.includes('PENDING')) return 'pending'
  return 'none'
}

function getRefundAdjustment(args: {
  order: EbayOrder
  lineItem: NonNullable<EbayOrder['lineItems']>[number]
  grossRevenue: number
  orderLineGrossTotal: number
}) {
  const { order, lineItem, grossRevenue, orderLineGrossTotal } = args
  const lineRefunds = lineItem.refunds || []
  const orderRefunds = order.paymentSummary?.refunds || []
  const lineRefundAmount = lineRefunds.reduce((sum, refund) => sum + parseMoney(refund.amount?.value), 0)
  const orderRefundAmount = orderRefunds.reduce((sum, refund) => sum + parseMoney(refund.amount?.value), 0)
  const orderStatuses = [
    order.orderPaymentStatus,
    order.cancelStatus?.cancelState,
    ...orderRefunds.map((refund) => refund.refundStatus),
  ].map((status) => String(status || '').toUpperCase())
  const lineStatuses = lineRefunds.map((refund) => String(refund.refundStatus || '').toUpperCase())
  const fullOrderRefund = orderStatuses.includes('FULLY_REFUNDED')
  const fullLineRefund = lineStatuses.includes('FULLY_REFUNDED')

  const allocatedOrderRefund = lineRefunds.length > 0
    ? 0
    : fullOrderRefund && orderRefundAmount <= 0
      ? grossRevenue
      : orderLineGrossTotal > 0
        ? orderRefundAmount * (grossRevenue / orderLineGrossTotal)
        : orderRefundAmount

  const explicitRefund = fullLineRefund && lineRefundAmount <= 0 ? grossRevenue : lineRefundAmount
  const refundedAmount = Math.min(grossRevenue, Math.max(0, explicitRefund + allocatedOrderRefund))
  const refundStatus = getRefundStatus([...orderStatuses, ...lineStatuses], refundedAmount, grossRevenue)

  return {
    refundedAmount: refundStatus === 'full' && refundedAmount <= 0 ? grossRevenue : refundedAmount,
    refundStatus,
  }
}

function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(pack|set|piece|pcs|count|for|with|and|the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getDateRangeFilter(orders: EbayOrder[]) {
  const timestamps = orders
    .map((order) => new Date(order.creationDate).getTime())
    .filter((value) => Number.isFinite(value))

  if (timestamps.length === 0) return ''

  const start = new Date(Math.min(...timestamps) - 24 * 60 * 60 * 1000).toISOString()
  const end = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  return `transactionType:{SALE},transactionDate:[${start}..${end}]`
}

async function fetchFinancialOrders(base: string, accessToken: string) {
  const orders: EbayOrder[] = []
  const limit = 100
  let offset = 0
  let total: number | undefined

  while (offset < 1000) {
    const url = new URL(`${base}/sell/fulfillment/v1/order`)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Language': 'en-US',
      },
      signal: AbortSignal.timeout(12000),
    })

    if (response.status === 401) {
      return {
        response,
        orders,
      }
    }

    if (!response.ok) {
      return {
        response,
        orders,
      }
    }

    const payload = (await response.json()) as EbayOrdersPayload
    const pageOrders = Array.isArray(payload.orders) ? payload.orders : []
    orders.push(...pageOrders)
    total = typeof payload.total === 'number' ? payload.total : total

    if (pageOrders.length < limit || (typeof total === 'number' && orders.length >= total)) break
    offset += limit
  }

  return {
    response: null,
    orders,
  }
}

async function getActualFeeMaps(base: string, accessToken: string, orders: EbayOrder[]) {
  const orderIds = new Set(orders.map((order) => order.orderId).filter(Boolean))
  const byOrder = new Map<string, number>()
  const byLine = new Map<string, number>()
  const filter = getDateRangeFilter(orders)
  let available = false
  let status: number | null = null

  if (orderIds.size === 0 || !filter) return { byOrder, byLine, available, status }

  try {
    let offset = 0
    const limit = 200

    while (offset < 1000) {
      const url = new URL(`${base}/sell/finances/v1/transaction`)
      url.searchParams.set('limit', String(limit))
      url.searchParams.set('offset', String(offset))
      url.searchParams.set('filter', filter)

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Language': 'en-US',
        },
        signal: AbortSignal.timeout(10000),
      })

      status = response.status
      if (!response.ok) break
      available = true

      const payload = (await response.json()) as { transactions?: EbayTransaction[]; total?: number }
      const transactions = Array.isArray(payload.transactions) ? payload.transactions : []

      for (const transaction of transactions) {
        const orderId = String(transaction.orderId || '')
        if (!orderIds.has(orderId)) continue

        const orderFee = parseMoney(transaction.totalFeeAmount?.value)
        if (orderFee > 0) byOrder.set(orderId, (byOrder.get(orderId) || 0) + orderFee)

        for (const lineItem of transaction.orderLineItems || []) {
          const lineItemId = String(lineItem.lineItemId || '')
          if (!lineItemId) continue

          const lineFee = (lineItem.marketplaceFees || []).reduce(
            (sum, fee) => sum + parseMoney(fee.amount?.value),
            0
          )

          if (lineFee > 0) {
            byLine.set(`${orderId}:${lineItemId}`, (byLine.get(`${orderId}:${lineItemId}`) || 0) + lineFee)
          }
        }
      }

      if (transactions.length < limit || (payload.total && offset + limit >= payload.total)) break
      offset += limit
    }
  } catch {
    // Financials can still load with estimated fees when eBay Finances is unavailable.
  }

  return { byOrder, byLine, available, status }
}

const PERIOD_DAYS: Record<string, number | null> = {
  '30d': 30,
  '90d': 90,
  '6m': 183,
  '1y': 365,
  'all': null,
}

export async function GET(req: Request) {
  const period = new URL(req.url).searchParams.get('period') || '30d'
  const periodDays = Object.hasOwn(PERIOD_DAYS, period) ? PERIOD_DAYS[period] : 30
  const cutoff = periodDays ? new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000) : null

  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    if (!credentials?.accessToken) {
      return apiOk({
        connected: false,
        summary: {
          grossRevenue: 0,
          trackedRevenue: 0,
          amazonCost: 0,
          ebayFees: 0,
          profit: 0,
          roi: 0,
          margin: 0,
          soldItems: 0,
          trackedItems: 0,
          missingCostItems: 0,
        },
        items: [],
      })
    }

    await ensureListedAsinsFinancialColumns()

    const base = credentials.sandboxMode ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
    const orderResult = await fetchFinancialOrders(base, credentials.accessToken)
    const response = orderResult.response

    if (response?.status === 401) {
      return apiError('Your eBay session expired. Reconnect your account in Settings.', {
        status: 401,
        code: 'RECONNECT_REQUIRED',
      })
    }

    if (response && !response.ok) {
      const detail = await response.text()
      return apiError(`Unable to load financial order data from eBay (${response.status}).`, {
        status: 502,
        code: 'EBAY_FINANCIALS_FAILED',
        details: detail.slice(0, 400),
      })
    }

    const orders = cutoff
      ? orderResult.orders.filter(o => o.creationDate && new Date(o.creationDate) >= cutoff)
      : orderResult.orders
    const actualFeeMaps = await getActualFeeMaps(base, credentials.accessToken, orders)

    let listingRows = await queryRows<ListedAsinRow>`
      SELECT asin, title, ebay_listing_id, amazon_price, ebay_price, ebay_fee_rate
      FROM listed_asins
      WHERE user_id = ${session.user.id}
        AND ebay_listing_id IS NOT NULL
    `

    // Live-lookup prices for rows missing amazon_price — run up to 5 in parallel
    const missingPriceAsins = listingRows
      .filter(r => (r.amazon_price === null || r.amazon_price === undefined) && r.asin)
      .map(r => String(r.asin))
      .filter((asin, i, arr) => arr.indexOf(asin) === i) // dedupe
      .slice(0, 5)

    if (missingPriceAsins.length > 0) {
      const resolved = await Promise.all(
        missingPriceAsins.map(asin => resolveAmazonPrice(asin, String(session.user.id)).then(price => ({ asin, price })))
      )
      // Patch the in-memory rows so this request uses the live price
      for (const { asin, price } of resolved) {
        if (price === null) continue
        for (const row of listingRows) {
          if (String(row.asin) === asin && (row.amazon_price === null || row.amazon_price === undefined)) {
            row.amazon_price = price
          }
        }
      }
    }

    const listingIdSet = new Set(listingRows.map((row) => String(row.ebay_listing_id || '')).filter(Boolean))
    const itemIdsNeedingRecovery = Array.from(
      new Set(
        orders.flatMap((order) =>
          (order.lineItems || [])
            .map((lineItem) => String(lineItem.legacyItemId || '').trim())
            .filter(Boolean)
        )
      )
    ).filter((itemId) => {
      const listing = listingRows.find((row) => String(row.ebay_listing_id || '') === itemId)
      if (!listingIdSet.has(itemId)) return true
      return !listing?.asin || listing.amazon_price === null || listing.amazon_price === undefined
    })

    if (itemIdsNeedingRecovery.length > 0) {
      const rapidKey = getRapidApiKey()
      const appId = process.env.EBAY_APP_ID || ''

      for (let index = 0; index < itemIdsNeedingRecovery.length; index += 5) {
        const batch = itemIdsNeedingRecovery.slice(index, index + 5)
        await Promise.all(
          batch.map((itemId) =>
            recoverAmazonProductByItemId({
              userId: session.user.id,
              itemId,
              accessToken: credentials.accessToken,
              appId,
              rapidKey,
            }).catch(() => null)
          )
        )
      }

      listingRows = await queryRows<ListedAsinRow>`
        SELECT asin, title, ebay_listing_id, amazon_price, ebay_price, ebay_fee_rate
        FROM listed_asins
        WHERE user_id = ${session.user.id}
          AND ebay_listing_id IS NOT NULL
      `
    }

    const listingById = new Map(
      listingRows
        .filter((row) => row.ebay_listing_id)
        .map((row) => [String(row.ebay_listing_id), row] as const)
    )
    const listingsByTitle = new Map<string, ListedAsinRow[]>()
    for (const row of listingRows) {
      const normalized = normalizeTitle(String(row.title || ''))
      if (!normalized) continue
      const current = listingsByTitle.get(normalized) || []
      current.push(row)
      listingsByTitle.set(normalized, current)
    }

    const items = orders.flatMap((order) => {
      const orderLineGrossTotal = (order.lineItems || []).reduce((sum, lineItem) => {
        const fallbackRevenue = (order.lineItems?.length || 0) <= 1 ? parseMoney(order.pricingSummary?.total?.value) : 0
        return sum + (parseMoney(lineItem.lineItemCost?.value) || fallbackRevenue)
      }, 0)

      return (order.lineItems || []).map((lineItem, index) => {
        const listingId = lineItem.legacyItemId ? String(lineItem.legacyItemId) : ''
        const normalizedTitle = normalizeTitle(String(lineItem.title || ''))
        const titleMatches = normalizedTitle ? listingsByTitle.get(normalizedTitle) || [] : []
        const listing = listingId ? listingById.get(listingId) : titleMatches.length === 1 ? titleMatches[0] : undefined
        const quantity = Math.max(1, Number(lineItem.quantity || 1))
        const fallbackRevenue = (order.lineItems?.length || 0) <= 1 ? parseMoney(order.pricingSummary?.total?.value) : 0
        const grossLineRevenue = parseMoney(lineItem.lineItemCost?.value) || fallbackRevenue
        const refund = getRefundAdjustment({ order, lineItem, grossRevenue: grossLineRevenue, orderLineGrossTotal })
        const revenue = Math.max(0, grossLineRevenue - refund.refundedAmount)
        const isFullRefund = refund.refundStatus === 'full'
        const amazonUnitCost = listing?.amazon_price === null || listing?.amazon_price === undefined ? null : parseMoney(listing.amazon_price)
        const amazonCost = isFullRefund ? 0 : amazonUnitCost === null ? null : amazonUnitCost * quantity * (1 + AMAZON_SOURCE_TAX_RATE)
        const feeRate = listing?.ebay_fee_rate === null || listing?.ebay_fee_rate === undefined ? EBAY_DEFAULT_FEE_RATE : Number(listing.ebay_fee_rate)
        const lineItemId = String(lineItem.lineItemId || '')
        const actualLineFee = lineItemId ? actualFeeMaps.byLine.get(`${order.orderId}:${lineItemId}`) : undefined
        const actualOrderFee = (order.lineItems?.length || 0) <= 1 ? actualFeeMaps.byOrder.get(order.orderId) : undefined
        const estimatedFees =
          grossLineRevenue * feeRate +
          grossLineRevenue * PROMOTED_AD_RATE +
          grossLineRevenue * PRICING_BUFFER_RATE +
          getFixedFee(grossLineRevenue)
        const grossFees = actualLineFee ?? actualOrderFee ?? estimatedFees
        const feeMultiplier = grossLineRevenue > 0 ? revenue / grossLineRevenue : 1
        const internalBuffer = actualLineFee !== undefined || actualOrderFee !== undefined
          ? grossLineRevenue * PRICING_BUFFER_RATE * feeMultiplier
          : 0
        const ebayFees = Math.max(0, grossFees * feeMultiplier + internalBuffer)
        const feeSource = actualLineFee !== undefined || actualOrderFee !== undefined ? 'actual' : 'estimated'
        const profit = amazonCost === null ? null : revenue - amazonCost - ebayFees
        const roi = amazonCost && amazonCost > 0 && profit !== null ? (profit / amazonCost) * 100 : null
        const margin = revenue > 0 && profit !== null ? (profit / revenue) * 100 : null

        return {
          id: `${order.orderId}:${listingId || index}`,
          orderId: order.orderId,
          listingId: listingId || null,
          asin: listing?.asin ? String(listing.asin) : null,
          title: lineItem.title || listing?.title || order.orderId,
          soldAt: order.creationDate,
          quantity,
          grossRevenue: grossLineRevenue,
          ebayRevenue: revenue,
          refundedAmount: refund.refundedAmount,
          refundStatus: refund.refundStatus,
          amazonUnitCost,
          amazonCost,
          amazonLandedCost: amazonCost,
          amazonTaxRate: AMAZON_SOURCE_TAX_RATE,
          ebayFeeRate: feeRate,
          ebayFees,
          feeSource,
          profit,
          roi,
          margin,
          hasTrackedCost: amazonCost !== null,
        }
      })
    })

    const grossRevenue = items.reduce((sum, item) => sum + item.ebayRevenue, 0)
    const grossSalesRevenue = items.reduce((sum, item) => sum + item.grossRevenue, 0)
    const refundedRevenue = items.reduce((sum, item) => sum + item.refundedAmount, 0)
    const refundedItems = items.filter((item) => item.refundStatus !== 'none').length
    const trackedItems = items.filter((item) => item.hasTrackedCost)
    const actualFeeItems = items.filter((item) => item.feeSource === 'actual').length
    const estimatedFeeItems = items.length - actualFeeItems
    const financeApiAvailable = actualFeeMaps.available
    const trackedRevenue = trackedItems.reduce((sum, item) => sum + item.ebayRevenue, 0)
    const amazonCost = trackedItems.reduce((sum, item) => sum + (item.amazonCost || 0), 0)
    const ebayFees = trackedItems.reduce((sum, item) => sum + item.ebayFees, 0)
    const profit = trackedItems.reduce((sum, item) => sum + (item.profit || 0), 0)
    const roi = amazonCost > 0 ? (profit / amazonCost) * 100 : 0
    const margin = trackedRevenue > 0 ? (profit / trackedRevenue) * 100 : 0

    return apiOk({
      connected: true,
      summary: {
        grossRevenue,
        grossSalesRevenue,
        refundedRevenue,
        trackedRevenue,
        amazonCost,
        ebayFees,
        profit,
        roi,
        margin,
        soldItems: items.length,
        refundedItems,
        trackedItems: trackedItems.length,
        missingCostItems: items.length - trackedItems.length,
        actualFeeItems,
        estimatedFeeItems,
        financeApiAvailable,
        financeApiStatus: actualFeeMaps.status,
      },
      items,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError(error.message, {
        status: 401,
        code: 'RECONNECT_REQUIRED',
      })
    }

    if (error instanceof EbayNetworkError) {
      return apiError(error.message, {
        status: 503,
        code: 'EBAY_NETWORK_ERROR',
      })
    }

    const message = getErrorText(error, 'Unable to load financial data.')
    if (/invalid refresh token|token refresh failed|expired|revoked|reconnect/i.test(message)) {
      return apiError('Your eBay session expired. Reconnect your account in Settings.', {
        status: 401,
        code: 'RECONNECT_REQUIRED',
        details: message,
      })
    }

    if (/fetch failed/i.test(message)) {
      return apiError('Unable to reach eBay right now. Please try again in a minute or reconnect eBay in Settings.', {
        status: 503,
        code: 'EBAY_NETWORK_ERROR',
      })
    }

    return apiError(message, {
      status: 500,
      code: 'FINANCIALS_LOAD_FAILED',
    })
  }
}
