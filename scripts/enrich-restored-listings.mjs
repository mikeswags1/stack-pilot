// Targeted Browse-API enrichment for listings that are back to active but lack
// competitor data. Sequential calls with 700ms pacing — well under eBay's burst
// limit. Saves count + min_price to product_source_items. Quota-aware: stops
// cleanly on 429 instead of looping into a wall.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

// OAuth client-credentials token (Browse API)
const basic = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
const tr = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
})
const token = (await tr.json()).access_token
if (!token) { console.error('OAuth token fetch failed'); process.exit(1) }

// Title → keyword extraction (matches lib/listing-quality getMeaningfulTitleWords)
const STOP = new Set(['the','a','an','of','for','with','and','or','to','in','on','at','from','by','is','as','that','this','it','be','are','was','were','will','your','our','their','his','her','its','my','me','you','i','we','us','they','them','any','some','all','no','not'])
function buildKeywords(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 5)
    .join(' ')
}

async function queryComp(keywords) {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  url.searchParams.set('q', keywords)
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW}')
  url.searchParams.set('limit', '10')
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  if (!res) return null
  if (res.status === 429) return { rateLimit: true }
  if (!res.ok) return null
  const j = await res.json().catch(() => null)
  if (!j) return null
  const count = typeof j.total === 'number' ? j.total : 0
  const prices = (j.itemSummaries || []).map((it) => parseFloat(String(it?.price?.value || '0'))).filter((p) => Number.isFinite(p) && p > 0)
  const minPrice = prices.length > 0 ? Math.min(...prices) : null
  return { count, minPrice }
}

// Target: active listings (restored or original) where the source row lacks competition data
const candidates = await sql(`
  SELECT psi.asin, psi.title
  FROM product_source_items psi
  JOIN listed_asins la ON UPPER(la.asin) = UPPER(psi.asin)
  WHERE la.ended_at IS NULL
    AND psi.ebay_competitor_count IS NULL
  GROUP BY psi.asin, psi.title
  ORDER BY MIN(la.listed_at) DESC
`)
console.log(`Candidates needing enrichment: ${candidates.length}`)
console.log(`At 700ms pacing: ~${Math.round(candidates.length * 0.7 / 60)} minutes\n`)

let enriched = 0
let skipped = 0
let failed = 0
let rateLimitedAt = null

for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i]
  const keywords = buildKeywords(c.title)
  if (!keywords) { skipped++; continue }

  const result = await queryComp(keywords)
  if (result?.rateLimit) {
    rateLimitedAt = i
    console.log(`\n[${i}/${candidates.length}] Hit 429 rate-limit — stopping cleanly. Resume tomorrow.`)
    break
  }
  if (!result) { failed++; continue }

  await sql(
    `UPDATE product_source_items
     SET ebay_competitor_count = $1,
         ebay_competitor_min_price = $2,
         last_intelligence_at = NOW()
     WHERE asin = $3`,
    [result.count, result.minPrice, c.asin],
  )
  enriched++

  if ((i + 1) % 50 === 0) {
    process.stdout.write(`\r  Progress: ${i + 1}/${candidates.length} | enriched=${enriched} skipped=${skipped} failed=${failed}`)
  }
  await new Promise((r) => setTimeout(r, 700))
}

console.log(`\n\n=== ENRICHMENT COMPLETE ===`)
console.log(`  Enriched:      ${enriched}`)
console.log(`  Skipped:       ${skipped}`)
console.log(`  Failed:        ${failed}`)
console.log(`  Rate-limited:  ${rateLimitedAt !== null ? `yes (stopped at row ${rateLimitedAt})` : 'no'}`)

const post = await sql(`
  SELECT COUNT(*) FILTER (WHERE psi.ebay_competitor_count IS NULL)::int still_unknown,
         COUNT(*) FILTER (WHERE psi.ebay_competitor_count IS NOT NULL AND psi.ebay_competitor_min_price IS NOT NULL)::int with_full_data,
         COUNT(*)::int total
  FROM product_source_items psi
  JOIN listed_asins la ON UPPER(la.asin) = UPPER(psi.asin)
  WHERE la.ended_at IS NULL
`)
console.log(`\n  Post-enrichment coverage:`)
console.log(`    Active listings with full competitor data: ${post[0].with_full_data} / ${post[0].total}`)
console.log(`    Still missing competition data:            ${post[0].still_unknown}`)
