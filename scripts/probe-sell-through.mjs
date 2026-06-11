// PROBE: can we get eBay sold-quantity data via the official Browse API?
// For 3 market-survivor products: search competitors, then getItem on the top
// few and check estimatedAvailabilities[].estimatedSoldQuantity.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

// Browse app token via client credentials
const basic = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
  body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
})
if (!tokenRes.ok) { console.error('token failed', tokenRes.status, (await tokenRes.text()).slice(0, 200)); process.exit(1) }
const token = (await tokenRes.json()).access_token

const products = await sql`
  SELECT asin, title FROM product_source_items
  WHERE active = TRUE
    AND ebay_competitor_count IS NOT NULL AND ebay_competitor_count BETWEEN 3 AND 50
    AND amazon_price BETWEEN 25 AND 60
  ORDER BY total_score DESC LIMIT 3`

for (const p of products) {
  const kw = p.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 5).join(' ')
  console.log(`\n=== ${p.asin}: "${kw}"`)
  const u = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  u.searchParams.set('q', kw)
  u.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW}')
  u.searchParams.set('limit', '3')
  const sr = await fetch(u, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } })
  if (!sr.ok) { console.log('  search failed', sr.status); continue }
  const sj = await sr.json()
  const items = sj.itemSummaries || []
  console.log(`  competitors total=${sj.total}, inspecting top ${items.length}`)
  for (const it of items) {
    const gr = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(it.itemId)}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    })
    if (!gr.ok) { console.log(`   getItem ${it.itemId}: HTTP ${gr.status}`); continue }
    const gj = await gr.json()
    const est = gj.estimatedAvailabilities || []
    const sold = est.map((e) => e.estimatedSoldQuantity).filter((v) => typeof v === 'number')
    console.log(`   $${it.price?.value}  sold=${sold.length ? sold.join('/') : 'N/A'}  avail=${est.map(e=>e.estimatedAvailableQuantity ?? '?').join('/')}`)
    await new Promise(r => setTimeout(r, 700))
  }
  await new Promise(r => setTimeout(r, 700))
}
