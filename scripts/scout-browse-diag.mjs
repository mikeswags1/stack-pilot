import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const basic = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
const tr = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
  method: 'POST',
  headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
})
const token = (await tr.json()).access_token

for (const variant of [
  { label: 'enricher (no price filter)', filter: 'buyingOptions:{FIXED_PRICE},conditions:{NEW}' },
  { label: 'scout exact filter', filter: 'buyingOptions:{FIXED_PRICE},conditions:{NEW},priceCurrency:USD,price:[10..150]' },
  { label: 'price range only', filter: 'price:[10..150],priceCurrency:USD' },
  { label: 'no filter', filter: '' },
]) {
  const u = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  u.searchParams.set('q', 'car phone mount magnetic vent')
  if (variant.filter) u.searchParams.set('filter', variant.filter)
  u.searchParams.set('limit', '5')
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } })
  const j = await r.json()
  console.log(`\n[${variant.label}]`)
  console.log(`  status=${r.status} total=${j.total} items=${j.itemSummaries?.length || 0}`)
  if (j.errors) console.log(`  ERRORS: ${JSON.stringify(j.errors).slice(0, 250)}`)
  if (j.warnings) console.log(`  WARNINGS: ${JSON.stringify(j.warnings).slice(0, 250)}`)
  await new Promise(r => setTimeout(r, 800))
}
