// Fast turnaround: 4 Amazon titles → ASIN + Balanced-strategy eBay price + ROI.
// Outputs the ASINs to paste into the dashboard's Product Listing tab.

import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)

const TITLES = [
  { search: 'KastKing Megatron Spinning Reel 7+1 stainless aluminum', amazon_price: 53.54 },
  { search: 'Sougayilang fishing rod reel combo telescopic carrier bag', amazon_price: 47.44 },
  { search: 'KastKing Megatron Titanium Telescopic fishing rod IM7 graphite', amazon_price: 69.99 },
  { search: 'KastKing Megatron Titanium Telescopic fishing rod IM7 graphite travel', amazon_price: 64.99 },
]

// Get eBay app token for Browse API
const basic = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
const tr = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
})
const token = (await tr.json()).access_token

// Look up competitor min on eBay
async function getEbayMinPrice(query) {
  const u = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  u.searchParams.set('q', query)
  u.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW}')
  u.searchParams.set('limit', '15')
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } })
  if (!r.ok) return { error: `HTTP ${r.status}` }
  const j = await r.json()
  const total = j.total || 0
  const prices = (j.itemSummaries || []).map((it) => parseFloat(String(it?.price?.value || '0'))).filter((p) => p > 0)
  const min = prices.length ? Math.min(...prices) : null
  const median = prices.length ? prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)] : null
  return { total, min, median, sample_count: prices.length }
}

// Amazon scrape for ASIN (using the search page)
async function findAmazonAsin(query) {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity',
  }
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) }).catch(() => null)
  if (!r || !r.ok) return null
  const html = await r.text()
  if (html.includes('api-services-support@amazon.com')) return null
  // grab first non-sponsored ASIN
  const blocks = html.match(/data-asin="([A-Z0-9]{10})"[\s\S]*?(?=data-asin="|$)/g) || []
  for (const b of blocks) {
    if (b.includes('AdHolder') || b.includes('Sponsored')) continue
    const asin = b.match(/data-asin="([A-Z0-9]{10})"/)?.[1]
    if (asin) return asin
  }
  return null
}

// Fallback: RapidAPI search
async function findAmazonAsinRapid(query) {
  const key = env.RAPIDAPI_KEY
  if (!key) return null
  const url = `https://real-time-amazon-data.p.rapidapi.com/search?query=${encodeURIComponent(query)}&country=US&page=1`
  const r = await fetch(url, {
    headers: { 'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com', 'x-rapidapi-key': key },
  }).catch(() => null)
  if (!r || !r.ok) return null
  const j = await r.json()
  const p = (j?.data?.products || [])[0]
  return p?.asin || null
}

// Balanced strategy: floor = MAX(amazon×1.25, amazon+$4, comp_min×0.95). target = comp_min - $0.50.
function priceIt(amazonCost, compMin) {
  const floor = Math.max(amazonCost * 1.25, amazonCost + 4, compMin * 0.95)
  const target = compMin - 0.50
  const proposed = Math.max(floor, target)
  const unwinnable = floor > compMin * 1.12
  const fees = proposed * (0.13 + 0.029) + 0.30
  const ship = 3.0
  const profit = proposed - amazonCost - fees - ship
  const roi = (profit / amazonCost) * 100
  return { floor: Number(floor.toFixed(2)), proposed: Number(proposed.toFixed(2)), profit: Number(profit.toFixed(2)), roi: Number(roi.toFixed(1)), unwinnable }
}

console.log('Looking up ASINs + eBay competitor min for 4 products...\n')

const results = []
for (let i = 0; i < TITLES.length; i++) {
  const t = TITLES[i]
  process.stdout.write(`[${i + 1}/4] ${t.search.slice(0, 50)}... `)
  let asin = await findAmazonAsin(t.search)
  if (!asin) asin = await findAmazonAsinRapid(t.search)
  const comp = await getEbayMinPrice(t.search)
  const pricing = comp.min ? priceIt(t.amazon_price, comp.min) : null
  results.push({ ...t, asin, comp, pricing })
  console.log(`ASIN=${asin || 'NOT FOUND'}  comp=$${comp.min || '?'} (${comp.total} listings)`)
  await new Promise((r) => setTimeout(r, 800))
}

console.log('\n=========================================================')
console.log('       4 PRODUCTS — LISTING RECOMMENDATIONS')
console.log('=========================================================')
for (let i = 0; i < results.length; i++) {
  const r = results[i]
  console.log(`\n--- Product ${i + 1} ---`)
  console.log(`Title:           ${r.search}`)
  console.log(`Amazon cost:     $${r.amazon_price.toFixed(2)}`)
  console.log(`ASIN:            ${r.asin || 'NOT FOUND — need manual lookup'}`)
  if (r.comp.min) {
    console.log(`eBay competitors: ${r.comp.total} (sample min $${r.comp.min}, median ~$${r.comp.median})`)
  } else {
    console.log(`eBay competitors: NONE FOUND (could be high opportunity OR query mismatch)`)
  }
  if (r.pricing) {
    if (r.pricing.unwinnable) {
      console.log(`*** UNWINNABLE under Balanced rule (floor > 1.12× competitor min) ***`)
      console.log(`    Floor would be $${r.pricing.floor}, competitor min only $${r.comp.min}`)
      console.log(`    Recommendation: SKIP — Amazon cost too high vs eBay market`)
    } else {
      console.log(`Recommended price: $${r.pricing.proposed}`)
      console.log(`Estimated profit: $${r.pricing.profit} per sale  |  ROI: ${r.pricing.roi}%`)
    }
  }
}

console.log('\n=========================================================')
console.log('TO LIST: dashboard → Product Listing → paste ASIN → confirm price')
console.log('=========================================================')
