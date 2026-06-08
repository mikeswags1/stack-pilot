// FULL AUDIT: run the REAL source engine, then apply the EXACT client-side
// getBulkPreflightIssue checks to see how many the browser would actually keep.
import fs from 'node:fs'
import path from 'node:path'
for (const line of fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  if (!line.includes('=') || line.startsWith('#')) continue
  const i = line.indexOf('='); const k = line.slice(0, i).trim()
  if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^"|"$/g, '')
}
const { loadProductSourceProducts } = await import('@/lib/product-source-engine')
const { isWeakListingTitle } = await import('@/lib/listing-quality')

const result = await loadProductSourceProducts({ limit: 90 })
console.log(`\nEngine returned: ${result.length}`)

// Replicate client countUniqueProductImages (app/dashboard/utils.ts)
const countImgs = (p: any) => Array.from(new Set([
  ...(Array.isArray(p.images) ? p.images : []),
  p.imageUrl,
].filter((u: any) => typeof u === 'string' && u.startsWith('http')))).length

// Replicate client getBulkPreflightIssue
const fails = { available: 0, weakTitle: 0, amazonPrice: 0, ebayPrice: 0, images: 0, profit: 0 }
let pass = 0
for (const p of result as any[]) {
  if (p.available === false) { fails.available++; continue }
  if (isWeakListingTitle(p.title)) { fails.weakTitle++; continue }
  if (!Number.isFinite(p.amazonPrice) || p.amazonPrice <= 0) { fails.amazonPrice++; continue }
  if (!Number.isFinite(p.ebayPrice) || p.ebayPrice <= 0) { fails.ebayPrice++; continue }
  if (countImgs(p) < 2) { fails.images++; continue }
  if (Number.isFinite(p.profit) && p.profit < 3) { fails.profit++; continue }
  pass++
}
console.log('CLIENT getBulkPreflightIssue results:')
console.log(`  PASS (would show in queue): ${pass}`)
console.log(`  fail available:   ${fails.available}`)
console.log(`  fail weak title:  ${fails.weakTitle}`)
console.log(`  fail amazonPrice: ${fails.amazonPrice}`)
console.log(`  fail ebayPrice:   ${fails.ebayPrice}`)
console.log(`  fail <2 images:   ${fails.images}`)
console.log(`  fail profit<3:    ${fails.profit}`)
// Show image counts of first few
console.log('\nSample image counts (client view):')
for (const p of (result as any[]).slice(0, 6)) {
  console.log(`  ${p.asin}: client=${countImgs(p)} images.len=${(p.images || []).length} imageUrl=${p.imageUrl ? 'yes' : 'no'}`)
}
