// eBay niche audit: query Browse API for each niche, rank by market viability.
// Outputs HOT / LUKEWARM / DEAD classification + suggestions.
//
// Method: For each niche, sample top eBay listings (Best Match = sales-velocity-sorted).
// Compute: market size (# results), avg price, % top-rated sellers, price coherence.
// Score normalized 0-100. Above 65 = HOT, 35-65 = LUKEWARM, below 35 = DEAD.

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

// Step 1: Get eBay application OAuth token (client_credentials flow)
async function getEbayAppToken() {
  const auth = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  })
  if (!res.ok) throw new Error(`eBay token request failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.access_token
}

// Step 2: For one query, fetch top 50 listings from eBay Best Match
async function fetchEbayBestMatch(query, token) {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '50')
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW}')
  url.searchParams.set('sort', 'bestMatch')

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return null
  return await res.json()
}

// Step 3: Score one niche based on its eBay market signals
function scoreNiche(samples, queries) {
  if (!samples.length) return { score: 0, marketSize: 0, avgPrice: 0, topRatedPct: 0, hot: false, dead: true }

  const allItems = samples.flatMap(s => s?.itemSummaries || [])
  const totalEstimate = Math.max(...samples.map(s => s?.total || 0))
  const prices = allItems
    .map(item => parseFloat(item.price?.value || '0'))
    .filter(p => p > 0 && p < 500)
  const topRated = allItems.filter(item => item.topRatedBuyingExperience === true).length
  const withFreeShipping = allItems.filter(item => (item.shippingOptions || []).some(s => parseFloat(s.shippingCost?.value || '0') === 0)).length

  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0
  const medianPrice = prices.length ? prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)] : 0
  const topRatedPct = allItems.length ? (topRated / allItems.length) * 100 : 0
  const freeShipPct = allItems.length ? (withFreeShipping / allItems.length) * 100 : 0

  // Scoring weights:
  //   Market size (0-30 pts):    >50K = 30, >20K = 25, >5K = 18, >1K = 10, <1K = 3
  //   Avg price ROI band (0-25): $15-60 = 25, $10-150 = 18, else = 8
  //   Top rated % (0-20):        >30% = 20, >15% = 14, >5% = 8, else = 3
  //   Free ship % (0-15):        >80% = 15, >50% = 10, else = 5
  //   Price coherence (0-10):    low std dev = 10, high = 3
  const sizeScore = totalEstimate > 50000 ? 30 : totalEstimate > 20000 ? 25 : totalEstimate > 5000 ? 18 : totalEstimate > 1000 ? 10 : 3
  const priceScore = (avgPrice >= 15 && avgPrice <= 60) ? 25 : (avgPrice >= 10 && avgPrice <= 150) ? 18 : 8
  const tierScore = topRatedPct > 30 ? 20 : topRatedPct > 15 ? 14 : topRatedPct > 5 ? 8 : 3
  const shipScore = freeShipPct > 80 ? 15 : freeShipPct > 50 ? 10 : 5
  const priceStdDev = prices.length > 1
    ? Math.sqrt(prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length)
    : 0
  const coherenceScore = priceStdDev < avgPrice * 0.5 ? 10 : priceStdDev < avgPrice ? 6 : 3

  const score = sizeScore + priceScore + tierScore + shipScore + coherenceScore

  return {
    score,
    marketSize: totalEstimate,
    avgPrice: Math.round(avgPrice * 100) / 100,
    medianPrice: Math.round(medianPrice * 100) / 100,
    topRatedPct: Math.round(topRatedPct),
    freeShipPct: Math.round(freeShipPct),
    sampleSize: allItems.length,
    hot: score >= 65,
    dead: score < 35,
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

console.log('Fetching eBay app token...')
const token = await getEbayAppToken()
console.log('OK\n')

// Pull niches + their queries from the database (BASE + custom + trending)
console.log('Loading active niches from product_source_items...')
const niches = await sql(`
  SELECT DISTINCT source_niche AS niche, COUNT(*)::int AS pool_count
  FROM product_source_items WHERE active = TRUE AND source_niche IS NOT NULL
  GROUP BY 1 ORDER BY pool_count DESC
`)
console.log(`Found ${niches.length} niches with active pool products\n`)

// For each niche we pick the niche name itself + "{niche} bestseller" as 2 queries.
// Use as broad signal — eBay's Best Match aggregates the whole category.
const results = []
let i = 0
for (const { niche, pool_count } of niches) {
  i++
  process.stdout.write(`  [${String(i).padStart(2)}/${niches.length}] ${niche.padEnd(28)} `)
  const queries = [niche, `${niche} bestseller`]
  const samples = []
  for (const q of queries) {
    const data = await fetchEbayBestMatch(q, token)
    if (data) samples.push(data)
    // Tiny throttle so we don't hammer eBay
    await new Promise(r => setTimeout(r, 200))
  }
  const result = scoreNiche(samples, queries)
  results.push({ niche, pool_count, ...result })
  console.log(`score=${result.score} market=${result.marketSize.toLocaleString()} avg=$${result.avgPrice}`)
}

// ─── REPORT ───────────────────────────────────────────────────────────────

console.log('\n\n═══════════════════════════════════════════════════════════════════')
console.log('                    eBay NICHE AUDIT REPORT')
console.log('═══════════════════════════════════════════════════════════════════\n')

const sorted = results.sort((a, b) => b.score - a.score)
const hot = sorted.filter(r => r.hot)
const dead = sorted.filter(r => r.dead)
const lukewarm = sorted.filter(r => !r.hot && !r.dead)

console.log(`🔥 HOT niches (score ≥65): ${hot.length}`)
console.log(`🟡 LUKEWARM (35-64):       ${lukewarm.length}`)
console.log(`❌ DEAD niches (<35):       ${dead.length}\n`)

console.log('─── 🔥 HOT — enrich these first ───')
console.log('Score | Niche                          | Market   | $Avg | %TopRated | Pool')
for (const r of hot) {
  console.log(`  ${String(r.score).padStart(3)} | ${r.niche.padEnd(30)} | ${r.marketSize.toLocaleString().padStart(7)}+ | $${String(r.avgPrice).padStart(5)} | ${String(r.topRatedPct).padStart(7)}%  | ${r.pool_count}`)
}

console.log('\n─── 🟡 LUKEWARM — keep but lower priority ───')
console.log('Score | Niche                          | Market   | $Avg | %TopRated | Pool')
for (const r of lukewarm) {
  console.log(`  ${String(r.score).padStart(3)} | ${r.niche.padEnd(30)} | ${r.marketSize.toLocaleString().padStart(7)}+ | $${String(r.avgPrice).padStart(5)} | ${String(r.topRatedPct).padStart(7)}%  | ${r.pool_count}`)
}

console.log('\n─── ❌ DEAD — consider dropping ───')
console.log('Score | Niche                          | Market   | $Avg | %TopRated | Pool')
for (const r of dead) {
  console.log(`  ${String(r.score).padStart(3)} | ${r.niche.padEnd(30)} | ${r.marketSize.toLocaleString().padStart(7)}+ | $${String(r.avgPrice).padStart(5)} | ${String(r.topRatedPct).padStart(7)}%  | ${r.pool_count}`)
}

console.log('\n─── 💡 ENRICHMENT PRIORITY ORDER ───')
console.log('If you enrich HOT niches only, that covers:')
const hotPoolSum = hot.reduce((sum, r) => sum + r.pool_count, 0)
const totalPool = results.reduce((sum, r) => sum + r.pool_count, 0)
console.log(`  ${hotPoolSum} products (${Math.round(hotPoolSum / totalPool * 100)}% of pool)`)
console.log(`  vs full backlog: ${totalPool} products`)
console.log(`  RapidAPI cost if HOT only: ~${hotPoolSum} calls (vs ${totalPool})`)

// Write JSON report for downstream use
fs.writeFileSync(
  path.resolve(process.cwd(), 'scripts', 'niche-audit-results.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), hot, lukewarm, dead, all: sorted }, null, 2)
)
console.log('\nFull report saved to scripts/niche-audit-results.json')
