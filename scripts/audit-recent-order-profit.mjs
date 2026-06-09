import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=')
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^"|"$/g, '')]
    }),
)

const sql = neon(env.DATABASE_URL)
const USER_ID = Number(process.argv.find((arg) => arg.startsWith('--userId='))?.split('=')[1] || 1)
const DAYS = Number(process.argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] || 30)
const AMAZON_TAX_RATE = Number(env.AMAZON_SOURCE_TAX_RATE || env.AMAZON_TAX_RATE || '0.07')
const PROMOTED_AD_RATE = Number(env.PROMOTED_AD_RATE || '0.06')
const FALLBACK_EBAY_FEE_RATE = Number(env.EBAY_FEE_RATE || '0.136')
const BUFFER_RATE = Number(env.PRICING_BUFFER_RATE || '0.015')

function money(value) {
  const n = Number.parseFloat(String(value ?? '0').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

async function refreshTokenIfNeeded(row) {
  const token = String(row?.oauth_token || '')
  const expiresAt = row?.token_expires_at ? new Date(row.token_expires_at) : null
  if (token && expiresAt && expiresAt.getTime() > Date.now() + 5 * 60 * 1000) return token
  if (!row?.refresh_token) return token
  if (!env.EBAY_APP_ID || !env.EBAY_CERT_ID) return token

  const credentials = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
  ]
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
      scope: scopes.join(' '),
    }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.access_token) return token
  const refreshedExpiresAt = new Date(Date.now() + Number(data.expires_in || 7200) * 1000).toISOString()
  await sql`
    UPDATE ebay_credentials
    SET oauth_token = ${data.access_token}, token_expires_at = ${refreshedExpiresAt}, updated_at = NOW()
    WHERE user_id = ${USER_ID}
  `.catch(() => {})
  return data.access_token
}

async function getToken() {
  const [account] = await sql`
    SELECT oauth_token, refresh_token, token_expires_at, sandbox_mode
    FROM ebay_accounts
    WHERE user_id = ${USER_ID}
      AND active = TRUE
    ORDER BY id ASC
    LIMIT 1
  `.catch(() => [])
  const [legacy] = account ? [] : await sql`
    SELECT oauth_token, refresh_token, token_expires_at, sandbox_mode
    FROM ebay_credentials
    WHERE user_id = ${USER_ID}
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `.catch(() => [])
  const row = account || legacy
  if (!row) throw new Error(`No eBay credentials for user ${USER_ID}`)
  return {
    token: await refreshTokenIfNeeded(row),
    sandbox: Boolean(row.sandbox_mode),
  }
}

async function fetchOrders(base, token) {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()
  const orders = []
  for (let offset = 0; offset < 500; offset += 100) {
    const url = new URL(`${base}/sell/fulfillment/v1/order`)
    url.searchParams.set('filter', `creationdate:[${since}..]`)
    url.searchParams.set('limit', '100')
    url.searchParams.set('offset', String(offset))
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Language': 'en-US' },
    })
    if (!response.ok) throw new Error(`Fulfillment API ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const payload = await response.json()
    const page = Array.isArray(payload.orders) ? payload.orders : []
    orders.push(...page)
    if (page.length < 100 || (payload.total && orders.length >= payload.total)) break
  }
  return orders
}

async function fetchFeeMaps(base, token, orders) {
  const byOrder = new Map()
  const byLine = new Map()
  const since = new Date(Date.now() - (DAYS + 2) * 24 * 60 * 60 * 1000).toISOString()
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const orderIds = new Set(orders.map((order) => String(order.orderId || '')).filter(Boolean))

  for (let offset = 0; offset < 1000; offset += 200) {
    const url = new URL(`${base}/sell/finances/v1/transaction`)
    url.searchParams.set('filter', `transactionType:{SALE},transactionDate:[${since}..${until}]`)
    url.searchParams.set('limit', '200')
    url.searchParams.set('offset', String(offset))
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Language': 'en-US' },
    }).catch(() => null)
    if (!response || !response.ok) return { byOrder, byLine, available: false, status: response?.status ?? null }
    const payload = await response.json()
    const transactions = Array.isArray(payload.transactions) ? payload.transactions : []
    for (const transaction of transactions) {
      const orderId = String(transaction.orderId || '')
      if (!orderIds.has(orderId)) continue
      const orderFee = money(transaction.totalFeeAmount?.value)
      if (orderFee > 0) byOrder.set(orderId, (byOrder.get(orderId) || 0) + orderFee)
      for (const line of transaction.orderLineItems || []) {
        const lineItemId = String(line.lineItemId || '')
        const lineFee = (line.marketplaceFees || []).reduce((sum, fee) => sum + money(fee.amount?.value), 0)
        if (lineItemId && lineFee > 0) byLine.set(`${orderId}:${lineItemId}`, (byLine.get(`${orderId}:${lineItemId}`) || 0) + lineFee)
      }
    }
    if (transactions.length < 200 || (payload.total && offset + 200 >= payload.total)) break
  }

  return { byOrder, byLine, available: true, status: 200 }
}

const { token, sandbox } = await getToken()
if (!token) throw new Error(`No usable eBay token for user ${USER_ID}`)

const base = sandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
const orders = await fetchOrders(base, token)
const feeMaps = await fetchFeeMaps(base, token, orders)
const legacyIds = Array.from(new Set(
  orders.flatMap((order) => (order.lineItems || []).map((line) => String(line.legacyItemId || '')).filter(Boolean)),
))

const listingRows = legacyIds.length
  ? await sql`
      SELECT la.ebay_listing_id, la.asin, la.title, la.amazon_price, la.ebay_price, la.ebay_fee_rate,
             la.listed_at, la.sale_price, la.realized_profit,
             apc.amazon_price AS current_amazon_price, apc.available AS current_available
      FROM listed_asins la
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(la.asin)
      WHERE la.user_id = ${USER_ID}
        AND la.ebay_listing_id = ANY(${legacyIds}::text[])
    `
  : []
const listingById = new Map(listingRows.map((row) => [String(row.ebay_listing_id), row]))

const rows = []
for (const order of orders) {
  const orderLineGrossTotal = (order.lineItems || []).reduce((sum, line) => sum + (money(line.lineItemCost?.value) || 0), 0)
  for (const [index, line] of (order.lineItems || []).entries()) {
    const listingId = String(line.legacyItemId || '')
    const listing = listingById.get(listingId)
    const quantity = Math.max(1, Number(line.quantity || 1))
    const revenue = money(line.lineItemCost?.value) || ((order.lineItems || []).length <= 1 ? money(order.pricingSummary?.total?.value) : 0)
    const lineFee = line.lineItemId ? feeMaps.byLine.get(`${order.orderId}:${line.lineItemId}`) : undefined
    const orderFee = (order.lineItems || []).length <= 1 ? feeMaps.byOrder.get(order.orderId) : undefined
    const estimatedFee = revenue * (Number(listing?.ebay_fee_rate || FALLBACK_EBAY_FEE_RATE) + BUFFER_RATE + PROMOTED_AD_RATE) + (revenue <= 10 ? 0.3 : 0.4)
    const fees = lineFee ?? orderFee ?? estimatedFee
    const feeSource = lineFee !== undefined || orderFee !== undefined ? 'actual' : 'estimated'
    const storedAmazon = listing?.amazon_price == null ? null : money(listing.amazon_price)
    const currentAmazon = listing?.current_amazon_price == null ? null : money(listing.current_amazon_price)
    const storedLanded = storedAmazon == null ? null : storedAmazon * quantity * (1 + AMAZON_TAX_RATE)
    const currentLanded = currentAmazon == null ? null : currentAmazon * quantity * (1 + AMAZON_TAX_RATE)
    const netStored = storedLanded == null ? null : revenue - fees - storedLanded
    const netCurrent = currentLanded == null ? null : revenue - fees - currentLanded
    const listedPrice = listing?.ebay_price == null ? null : money(listing.ebay_price) * quantity
    const soldBelowListed = listedPrice != null && revenue < listedPrice - 0.5
    const costIncreased = storedAmazon != null && currentAmazon != null && currentAmazon > storedAmazon + 0.5
    const statuses = [
      order.orderPaymentStatus,
      order.orderFulfillmentStatus,
      order.cancelStatus?.cancelState,
      ...(order.paymentSummary?.refunds || []).map((refund) => refund.refundStatus),
      ...(line.refunds || []).map((refund) => refund.refundStatus),
    ].filter(Boolean).join('|')

    rows.push({
      orderId: order.orderId,
      created: order.creationDate,
      listingId,
      title: line.title || listing?.title || '',
      quantity,
      revenue,
      listedPrice,
      fees,
      feeSource,
      storedAmazon,
      currentAmazon,
      netStored,
      netCurrent,
      soldBelowListed,
      costIncreased,
      matched: Boolean(listing),
      statuses,
      itemIndex: index,
    })
  }
}

rows.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
const tracked = rows.filter((row) => row.matched && row.netStored != null)
const negative = tracked.filter((row) => (row.netCurrent ?? row.netStored ?? 0) < 0 || (row.netStored ?? 0) < 0)
const low = tracked.filter((row) => (row.netCurrent ?? row.netStored ?? 0) < 3)

console.log(`Recent order profit audit for user ${USER_ID} (${DAYS} days)`)
console.log(`Orders: ${orders.length}; line items: ${rows.length}; matched tracked: ${tracked.length}; finance fees: ${feeMaps.available ? 'actual' : `estimated (${feeMaps.status || 'unavailable'})`}`)
console.log(`Negative tracked lines: ${negative.length}; below $3 true-net: ${low.length}`)
console.log('')
console.log('Most recent tracked lines:')
for (const row of tracked.slice(0, 12)) {
  const causes = []
  if (row.soldBelowListed) causes.push('sold below listed')
  if (row.costIncreased) causes.push('Amazon cost increased')
  if (row.feeSource === 'estimated') causes.push('estimated fees')
  if (!row.currentAmazon) causes.push('no current cache cost')
  if (!causes.length) causes.push('thin margin')
  console.log(`${row.created.slice(0, 10)} | ${row.orderId} | item ${row.listingId || row.itemIndex}`)
  console.log(`  ${row.title.slice(0, 90)}`)
  console.log(`  revenue $${row.revenue.toFixed(2)} | listed ${row.listedPrice == null ? 'n/a' : `$${row.listedPrice.toFixed(2)}`} | fees $${row.fees.toFixed(2)} ${row.feeSource}`)
  console.log(`  Amazon stored ${row.storedAmazon == null ? 'n/a' : `$${row.storedAmazon.toFixed(2)}`} | current ${row.currentAmazon == null ? 'n/a' : `$${row.currentAmazon.toFixed(2)}`}`)
  console.log(`  net(stored) ${row.netStored == null ? 'n/a' : `$${row.netStored.toFixed(2)}`} | net(current) ${row.netCurrent == null ? 'n/a' : `$${row.netCurrent.toFixed(2)}`} | ${causes.join(', ')}`)
}

if (negative.length > 0) {
  console.log('')
  console.log('Negative/at-risk lines:')
  for (const row of low.slice(0, 20)) {
    console.log(`${row.created.slice(0, 10)} ${row.orderId} ${row.listingId}: net ${row.netCurrent == null ? row.netStored?.toFixed(2) : row.netCurrent.toFixed(2)} | revenue $${row.revenue.toFixed(2)} | stored cost ${row.storedAmazon} | current cost ${row.currentAmazon} | ${row.title.slice(0, 80)}`)
  }
}
