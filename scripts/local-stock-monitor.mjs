// LOCAL stock monitor — runs on the owner's laptop, checks Amazon directly from a
// RESIDENTIAL IP (rarely bot-blocked, costs $0). Updates the same evidence columns
// the cloud sweeps use, with the same explicit-only rules:
//   - explicit "currently unavailable"/OOS text  -> unavailable evidence (+1 confirm)
//   - buy box + price                            -> available, price verified
//   - anything ambiguous/blocked                 -> NO CHANGE (never condemn on silence)
// Then ends listings meeting the two-strike purge standard.
// Run: node scripts/local-stock-monitor.mjs [batch=150] [--apply-purge]
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const sql = neon(env.DATABASE_URL)
const BATCH = Math.max(10, Math.min(500, Number(process.argv[2] || '150')))
const APPLY_PURGE = process.argv.includes('--apply-purge')

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

// Priority: flagged-unavailable first (settle suspicions), then sold/watched,
// then stalest checks.
const rows = await sql(`
  SELECT user_id, ebay_listing_id, asin, ebay_price::float AS ebay_price
  FROM listed_asins
  WHERE ended_at IS NULL AND ebay_listing_id <> '' AND asin ~ '^[A-Z0-9]{10}$'
  ORDER BY
    (amazon_available = FALSE) DESC,
    (sold_at IS NOT NULL OR COALESCE(watch_count,0) > 0) DESC,
    amazon_status_checked_at ASC NULLS FIRST
  LIMIT $1
`, [BATCH])
console.log(`${rows.length} listings to check from local IP`)

let inStock = 0, oos = 0, blocked = 0
for (const r of rows) {
  let html = ''
  let pageGone = false
  try {
    const res = await fetch(`https://www.amazon.com/dp/${r.asin}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) })
    // A 404 on /dp/ASIN is EXPLICIT: the product page no longer exists (discontinued
    // or delisted). That is unfulfillable evidence, not ambiguity.
    if (res.status === 404) pageGone = true
    html = res.ok ? await res.text() : ''
  } catch { /* network -> treat as blocked */ }

  // Signal scoping (Amazon pages are ~2MB; the buy-box column spans tens of KB):
  //  - OOS text: tight window around id="availability" (that's exactly where it renders)
  //  - buy buttons: unique page ids, safe to test full-page (carousels never carry them)
  //  - price: anchored to Amazon's corePrice block; fall back to the page's FIRST
  //    priceAmount (which is the buy-box price object, ahead of any carousel JSON)
  const captcha = /captcha|Robot Check|automated access/i.test(html.slice(0, 3000))
  const availIdx = html.search(/id="availability"/)
  const availScope = availIdx >= 0 ? html.slice(Math.max(0, availIdx - 2000), availIdx + 5000) : html.slice(0, 400000)
  const explicitOOS = /Currently unavailable|temporarily out of stock|We don't know when or if this item will be back/i.test(availScope)
  const hasBuyBox = /id="add-to-cart-button"|id="buy-now-button"/i.test(html)
  const coreIdx = html.search(/id="corePrice|id="apex_desktop/)
  const priceScope = coreIdx >= 0 ? html.slice(coreIdx, coreIdx + 25000) : html
  let price = 0
  for (const p of [/"priceAmount":([0-9.]+)/, /class="a-price-whole">([\d,]+)/]) {
    const m = priceScope.match(p)
    if (m) { price = parseFloat(m[1].replace(/,/g, '')); if (price > 0) break }
  }
  const scope = availScope // fulfillment signals read from the availability/delivery block

  // Fulfillment — EXPLICIT signals only, from the scoped region:
  //   fast=true  : ships/sold by Amazon, or a delivery date within 4 days
  //   fast=false : a delivery date 6+ days out
  //   otherwise  : null (no claim recorded)
  let fastFulfillment = null
  const shipsFromAmazon = /Ships from\s*(?:<[^>]+>\s*)*Amazon(?:\.com)?\s*</i.test(scope) || /"shipsFrom"[^}]*Amazon/i.test(scope)
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
  const dm = scope.match(/deliver[a-z]*\s+(?:[A-Za-z]+day,?\s+)?([A-Z][a-z]+)\s+(\d{1,2})/)
  let deliveryDays = null
  if (dm) {
    const mi = months.indexOf(dm[1].toLowerCase())
    if (mi >= 0) {
      const now = new Date()
      let d = new Date(now.getFullYear(), mi, Number(dm[2]))
      if (d < now && now - d > 45 * 86400000) d = new Date(now.getFullYear() + 1, mi, Number(dm[2]))
      deliveryDays = Math.round((d - now) / 86400000)
    }
  }
  if (shipsFromAmazon || (deliveryDays !== null && deliveryDays <= 4)) fastFulfillment = true
  else if (deliveryDays !== null && deliveryDays >= 6) fastFulfillment = false

  if (!pageGone && (captcha || !html || (!explicitOOS && !(hasBuyBox && price > 0)))) {
    blocked++
  } else if (pageGone || (explicitOOS && !hasBuyBox)) {
    oos++
    await sql(`
      UPDATE listed_asins SET amazon_available = FALSE, amazon_status_reason = 'unavailable',
        amazon_status_checked_at = NOW(),
        amazon_unavailable_confirmed_count = amazon_unavailable_confirmed_count + 1,
        amazon_unavailable_first_seen_at = COALESCE(amazon_unavailable_first_seen_at, NOW()),
        amazon_unavailable_last_seen_at = NOW()
      WHERE ebay_listing_id = $1 AND ended_at IS NULL
    `, [r.ebay_listing_id])
  } else {
    inStock++
    // Profit floor at the FRESH price (same formula as store-safety-status):
    const net = r.ebay_price * (1 - 0.136 - 0.02 - 0.015) - (r.ebay_price <= 10 ? 0.30 : 0.40) - price * 1.07
    const belowFloor = net < 5
    await sql(`
      UPDATE listed_asins SET amazon_available = TRUE, amazon_status_reason = 'available',
        amazon_status_checked_at = NOW(), amazon_price = $2,
        amazon_verified_price = $2, amazon_price_verified_at = NOW(),
        amazon_price_verification_source = 'amazon_buy_box',
        amazon_fast_fulfillment = COALESCE($3, amazon_fast_fulfillment),
        amazon_fulfillment_verified_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE amazon_fulfillment_verified_at END,
        below_net_floor_at = CASE WHEN $4 THEN COALESCE(below_net_floor_at, NOW()) ELSE NULL END,
        amazon_unavailable_confirmed_count = 0,
        amazon_unavailable_first_seen_at = NULL, amazon_unavailable_last_seen_at = NULL
      WHERE ebay_listing_id = $1 AND ended_at IS NULL
    `, [r.ebay_listing_id, price, fastFulfillment, belowFloor])
  }
  const done = inStock + oos + blocked
  if (done % 25 === 0) console.log(`  ${done}/${rows.length}  (${inStock} in-stock, ${oos} explicit-OOS, ${blocked} blocked/ambiguous)`)
  await new Promise((x) => setTimeout(x, 9000 + Math.floor(Math.random() * 8000))) // 9-17s pacing — 300-in-a-row at 6-11s drew IP throttling
}
console.log(`\nCHECKED: ${inStock} in-stock (price refreshed), ${oos} explicit-OOS evidence, ${blocked} blocked/no-change`)

// Purge anything now meeting the two-strike standard.
if (APPLY_PURGE) {
  const { execSync } = await import('node:child_process')
  try {
    const out = execSync('node scripts/purge-confirmed-oos.mjs --apply', { cwd: path.resolve(new URL('..', import.meta.url).pathname.replace(/^\//, '')), encoding: 'utf8' })
    console.log(out)
  } catch (e) { console.log('purge step failed:', String(e).slice(0, 200)) }
}
