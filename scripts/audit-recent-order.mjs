// Audit the most recent eBay order's TRUE net profit.
// Pulls the order from Sell Fulfillment API, the fee from Sell Finances API (if
// available), and the source cost from listed_asins, then computes full P&L.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)
const AMAZON_TAX_RATE = Number(env.AMAZON_TAX_RATE || '0.07') // est. sales tax we pay buying on Amazon

const cred = await sql`SELECT oauth_token FROM ebay_credentials WHERE user_id = 1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`
const token = cred[0]?.oauth_token
if (!token) { console.error('No eBay token'); process.exit(1) }

const since = new Date(Date.now() - 60 * 86400 * 1000).toISOString()
const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=creationdate:[${since}..]&limit=10&sort=-creationdate`
const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Language': 'en-US' } })
if (!r.ok) { console.error('Fulfillment API', r.status, (await r.text()).slice(0, 300)); process.exit(1) }
const j = await r.json()
const orders = j.orders || []
if (orders.length === 0) { console.log('No orders in last 60 days.'); process.exit(0) }

const o = orders[0]
console.log('=== MOST RECENT eBay ORDER ===')
console.log(`Order ID:    ${o.orderId}`)
console.log(`Created:     ${o.creationDate}`)
console.log(`Status:      ${o.orderFulfillmentStatus}`)
const ps = o.pricingSummary || {}
const saleSubtotal = Number(ps.priceSubtotal?.value || 0)
const shipCharged = Number(ps.deliveryCost?.value || 0)
const taxBuyer = Number(ps.tax?.value || 0)
const grandTotal = Number(ps.total?.value || 0)

console.log('\n--- What the buyer paid ---')
console.log(`Item subtotal:        $${saleSubtotal.toFixed(2)}`)
console.log(`Shipping charged:     $${shipCharged.toFixed(2)}`)
console.log(`Sales tax (eBay remits, not yours): $${taxBuyer.toFixed(2)}`)
console.log(`Grand total:          $${grandTotal.toFixed(2)}`)

const li = (o.lineItems || [])[0] || {}
const legacyItemId = li.legacyItemId ? String(li.legacyItemId) : null
const sku = li.sku || null
console.log('\n--- Line item ---')
console.log(`Title:        ${li.title}`)
console.log(`legacyItemId: ${legacyItemId}`)
console.log(`SKU:          ${sku}`)
console.log(`Qty:          ${li.quantity}`)

// Look up our stored source cost
let row = null
if (legacyItemId) {
  const rows = await sql`SELECT asin, amazon_price, ebay_price, ebay_fee_rate, realized_profit, sale_price, title FROM listed_asins WHERE ebay_listing_id = ${legacyItemId} LIMIT 1`
  row = rows[0] || null
}
if (!row && sku) {
  const asinFromSku = sku.replace(/^EBAYDASH-/i, '')
  const rows = await sql`SELECT asin, amazon_price, ebay_price, ebay_fee_rate, realized_profit, sale_price, title FROM listed_asins WHERE UPPER(asin) = UPPER(${asinFromSku}) ORDER BY listed_at DESC LIMIT 1`
  row = rows[0] || null
}

console.log('\n--- Our source record (listed_asins) ---')
if (row) {
  console.log(`ASIN:             ${row.asin}`)
  console.log(`Stored Amazon $:  $${Number(row.amazon_price).toFixed(2)}`)
  console.log(`Stored eBay $:    $${Number(row.ebay_price).toFixed(2)}`)
  console.log(`Stored fee rate:  ${row.ebay_fee_rate}`)
} else {
  console.log('No matching listed_asins row found (cannot confirm source cost).')
}

// Try Finances API for the real fee
let realFee = null
try {
  const fr = await fetch(`https://api.ebay.com/sell/finances/v1/transaction?filter=transactionDate:[${since}..]&limit=50`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Language': 'en-US' },
  })
  if (fr.ok) {
    const fj = await fr.json()
    const txns = (fj.transactions || []).filter((t) => t.orderId === o.orderId)
    const fees = txns.filter((t) => t.transactionType === 'NON_SALE_CHARGE' || t.feeType)
    const feeSum = txns.reduce((s, t) => s + (t.totalFeeAmount ? Number(t.totalFeeAmount.value) : 0), 0)
    if (feeSum > 0) realFee = feeSum
    console.log(`\n(Finances API: found ${txns.length} txns for this order, fee sum $${feeSum.toFixed(2)})`)
  } else {
    console.log(`\n(Finances API not available: ${fr.status} — using estimate)`)
  }
} catch (e) { console.log('\n(Finances API error — using estimate)') }

// ---- P&L ----
const ebayFee = realFee != null ? realFee : (grandTotal * 0.1325 + 0.30)
const promotedFee = saleSubtotal * 0.06 // if enrolled at 6%
const amazonCost = row ? Number(row.amazon_price) : null
const amazonLanded = amazonCost != null ? amazonCost * (1 + AMAZON_TAX_RATE) : null
const ebayPayout = saleSubtotal + shipCharged - ebayFee - promotedFee

console.log('\n=== TRUE P&L ===')
console.log(`eBay payout (sale+ship - fees - promo):  $${ebayPayout.toFixed(2)}`)
console.log(`  eBay FVF (${realFee != null ? 'actual' : 'est 13.25%+$0.30'}):  -$${ebayFee.toFixed(2)}`)
console.log(`  Promoted 6%:                           -$${promotedFee.toFixed(2)}`)
if (amazonLanded != null) {
  console.log(`Amazon landed cost (price + ${(AMAZON_TAX_RATE*100).toFixed(0)}% tax): -$${amazonLanded.toFixed(2)}`)
  const net = ebayPayout - amazonLanded
  console.log(`\n>>> NET PROFIT: $${net.toFixed(2)}  ${net < 3 ? '⚠️ BELOW $3 FLOOR' : '✅'}`)
} else {
  console.log('Amazon cost unknown — cannot compute exact net.')
}
