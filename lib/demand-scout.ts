// Demand Scout — eBay-pull, Amazon-source product discovery.
//
// The existing sourcing engine pushes from Amazon (crawl niches, hope they sell on
// eBay). Demand Scout flips it: query the Browse API for what's already selling on
// eBay (real buyer demand), then reverse-match each hit to an Amazon ASIN with margin
// headroom, and feed those into the same source pool. Products land in
// product_source_items with sourceProvider='demand-scout' and naturally flow through
// the existing enrichment + saturation gate + Continuous Listing pipeline.
//
// The seed list focuses on categories eBay's buyer demographic actually buys in
// (auto, tools, fishing, sporting goods, pet, garden, hobby) — NOT categories
// Amazon dominates (fashion, beauty, books, supplements).

import { queryRows, sql } from '@/lib/db'
import { getEbayAppToken } from '@/lib/ebay-app-token'
import { scrapeAmazonSearch } from '@/lib/amazon-scrape'
import { isWeakListingTitle } from '@/lib/listing-quality'
import { hasBlockedListingPolicyFlag, getListingPolicyFlags } from '@/lib/listing-policy'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getRecommendedEbayPrice } from '@/lib/listing-pricing'
import { upsertProductSourceItems } from '@/lib/product-source-engine'

// ── Demand seeds — curated for eBay's high-demand buyer demographic ─────────────
const DEMAND_SEEDS: Array<{ niche: string; query: string }> = [
  // Auto parts & accessories — huge on eBay
  { niche: 'Auto Accessories', query: 'car phone mount magnetic vent' },
  { niche: 'Auto Accessories', query: 'dash cam front rear' },
  { niche: 'Auto Accessories', query: 'obd2 scanner bluetooth' },
  { niche: 'Auto Accessories', query: 'led headlight bulbs h11' },
  { niche: 'Auto Accessories', query: 'jump starter portable' },
  { niche: 'Auto Accessories', query: 'tire pressure gauge digital' },
  { niche: 'Auto Accessories', query: 'car cleaning detail kit' },
  { niche: 'Auto Accessories', query: 'seat cover universal' },
  // Tools & home improvement — Amazon doesn't crush here, eBay buyers love deals
  { niche: 'Tools', query: 'magnetic wristband tool' },
  { niche: 'Tools', query: 'ratchet wrench set' },
  { niche: 'Tools', query: 'digital caliper' },
  { niche: 'Tools', query: 'stud finder wall scanner' },
  { niche: 'Tools', query: 'drill bit set titanium' },
  { niche: 'Tools', query: 'multimeter electrical' },
  { niche: 'Tools', query: 'precision screwdriver set' },
  { niche: 'Tools', query: 'tape measure heavy duty 25ft' },
  // Fishing & hunting — eBay strength
  { niche: 'Fishing', query: 'fishing tackle box organizer' },
  { niche: 'Fishing', query: 'fishing lure kit bass' },
  { niche: 'Fishing', query: 'braided fishing line 30lb' },
  { niche: 'Fishing', query: 'fishing rod combo spinning' },
  { niche: 'Hunting', query: 'trail camera hunting' },
  { niche: 'Hunting', query: 'hunting knife folding' },
  { niche: 'Hunting', query: 'rangefinder hunting' },
  // Sporting goods
  { niche: 'Sporting Goods', query: 'resistance bands set workout' },
  { niche: 'Sporting Goods', query: 'foam roller muscle recovery' },
  { niche: 'Sporting Goods', query: 'yoga mat non slip thick' },
  { niche: 'Sporting Goods', query: 'pickleball paddle set' },
  { niche: 'Sporting Goods', query: 'jump rope speed' },
  { niche: 'Sporting Goods', query: 'ab roller wheel' },
  // Pet supplies
  { niche: 'Pet Supplies', query: 'dog grooming kit clippers' },
  { niche: 'Pet Supplies', query: 'pet hair remover brush' },
  { niche: 'Pet Supplies', query: 'dog harness no pull' },
  { niche: 'Pet Supplies', query: 'cat litter mat large' },
  { niche: 'Pet Supplies', query: 'automatic pet feeder' },
  { niche: 'Pet Supplies', query: 'dog dental chews' },
  // Garden & outdoor
  { niche: 'Garden', query: 'garden hose nozzle heavy duty' },
  { niche: 'Garden', query: 'pruning shears bypass' },
  { niche: 'Garden', query: 'weed puller stand up' },
  { niche: 'Garden', query: 'solar pathway lights outdoor' },
  { niche: 'Garden', query: 'garden kneeling pad foam' },
  // Computer & electronics accessories
  { niche: 'Computer Accessories', query: 'usb c hub multiport hdmi' },
  { niche: 'Computer Accessories', query: 'wireless mouse ergonomic' },
  { niche: 'Computer Accessories', query: 'mechanical keyboard compact' },
  { niche: 'Computer Accessories', query: 'laptop stand aluminum adjustable' },
  { niche: 'Computer Accessories', query: 'monitor arm desk mount' },
  { niche: 'Computer Accessories', query: 'cable management organizer desk' },
  // Mobile accessories (eBay buyers love deals here)
  { niche: 'Phone Accessories', query: 'phone tripod stand desktop' },
  { niche: 'Phone Accessories', query: 'magsafe wireless charger' },
  { niche: 'Phone Accessories', query: 'wireless earbuds case airpods' },
  { niche: 'Phone Accessories', query: 'power bank 20000mah fast charge' },
  // Hobby / crafts / collectibles supplies
  { niche: 'Hobbies', query: 'trading card sleeves deck protector' },
  { niche: 'Hobbies', query: 'card binder 9 pocket' },
  { niche: 'Hobbies', query: 'lego storage drawer organizer' },
  { niche: 'Hobbies', query: 'dice set polyhedral rpg' },
  { niche: 'Hobbies', query: 'model paint brush set fine' },
]

// Rolling seed index in DB so each cron run advances through the list rather than
// processing the first N seeds every time.
async function ensureScoutCursor() {
  await sql`
    CREATE TABLE IF NOT EXISTS demand_scout_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      seed_cursor INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`INSERT INTO demand_scout_state (id) VALUES (1) ON CONFLICT DO NOTHING`.catch(() => {})
}

async function nextSeedBatch(perRun: number): Promise<typeof DEMAND_SEEDS> {
  await ensureScoutCursor()
  const rows = await queryRows<{ seed_cursor: number }>`SELECT seed_cursor FROM demand_scout_state WHERE id = 1`.catch(() => [])
  const start = (rows[0]?.seed_cursor ?? 0) % DEMAND_SEEDS.length
  const batch: typeof DEMAND_SEEDS = []
  for (let i = 0; i < perRun; i++) batch.push(DEMAND_SEEDS[(start + i) % DEMAND_SEEDS.length])
  const next = (start + perRun) % DEMAND_SEEDS.length
  await sql`UPDATE demand_scout_state SET seed_cursor = ${next}, updated_at = NOW() WHERE id = 1`.catch(() => {})
  return batch
}

type EbayHit = { title: string; price: number; itemId: string; imageUrl: string }

async function searchEbayDemand(query: string, token: string, limit = 15): Promise<EbayHit[]> {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  url.searchParams.set('q', query)
  // BEST_MATCH ranks by eBay's own demand signal (sales velocity weighted), so the top
  // results ARE the demand signal — exactly what we want to mirror on our side.
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW},priceCurrency:USD,price:[10..150]')
  url.searchParams.set('limit', String(limit))
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  if (!res || !res.ok) return []
  type Sum = { itemId?: string; title?: string; price?: { value?: string }; image?: { imageUrl?: string }; thumbnailImages?: Array<{ imageUrl?: string }> }
  const data = (await res.json().catch(() => null)) as { itemSummaries?: Sum[] } | null
  return (data?.itemSummaries || []).flatMap((it) => {
    const price = parseFloat(String(it?.price?.value || '0'))
    if (!it?.title || !it?.itemId || !Number.isFinite(price) || price <= 0) return []
    return [{
      itemId: String(it.itemId),
      title: String(it.title),
      price,
      imageUrl: String(it?.image?.imageUrl || it?.thumbnailImages?.[0]?.imageUrl || ''),
    }]
  })
}

// Margin guard: leave room for 13% eBay fees, ~3% payment processing, $0-3 shipping,
// AND 25%+ ROI. Empirically this means Amazon cost ≤ eBay price × 0.62.
const MAX_AMAZON_COST_RATIO = 0.62

function isViableProduct(amazonPrice: number, ebayMinPrice: number, title: string): boolean {
  if (!Number.isFinite(amazonPrice) || amazonPrice < 8) return false
  if (amazonPrice > ebayMinPrice * MAX_AMAZON_COST_RATIO) return false
  if (isWeakListingTitle(title)) return false
  if (hasBlockedListingPolicyFlag(getListingPolicyFlags({ title }))) return false
  return true
}

export async function runDemandScout(options: { seedsPerRun?: number; perSeed?: number } = {}) {
  const seedsPerRun = Math.max(1, Math.min(options.seedsPerRun ?? 6, 20))
  const perSeed = Math.max(5, Math.min(options.perSeed ?? 15, 30))

  const token = await getEbayAppToken()
  if (!token) return { discovered: 0, considered: 0, inserted: 0, alreadyKnown: 0, skipped: 0, seeds: 0 }

  const seeds = await nextSeedBatch(seedsPerRun)

  let considered = 0
  let inserted = 0
  let alreadyKnown = 0
  let skipped = 0
  const itemsToUpsert: Parameters<typeof upsertProductSourceItems>[0] = []

  for (const seed of seeds) {
    const hits = await searchEbayDemand(seed.query, token, perSeed)
    if (hits.length === 0) continue

    // Min competitor price for this seed = the bottom-of-market reference.
    const ebayMinPrice = Math.min(...hits.map((h) => h.price))

    // Look at the top ~5 hits (best demand signal) and try to source each from Amazon.
    for (const hit of hits.slice(0, 5)) {
      considered++
      if (hasBlockedListingPolicyFlag(getListingPolicyFlags({ title: hit.title }))) { skipped++; continue }

      const amazonResults = await scrapeAmazonSearch(hit.title.slice(0, 80)).catch(() => [])
      if (amazonResults.length === 0) { skipped++; continue }
      const amazonTop = amazonResults[0]
      if (!amazonTop?.asin || !amazonTop?.title || !amazonTop?.price) { skipped++; continue }

      // Already in pool? Skip — existing pipeline handles it.
      const exists = await queryRows<{ asin: string }>`SELECT asin FROM product_source_items WHERE asin = ${amazonTop.asin} LIMIT 1`.catch(() => [])
      if (exists.length > 0) { alreadyKnown++; continue }

      if (!isViableProduct(amazonTop.price, ebayMinPrice, amazonTop.title)) { skipped++; continue }

      const ebayPrice = getRecommendedEbayPrice(amazonTop.price, EBAY_DEFAULT_FEE_RATE)
      const { profit, roi } = getListingMetrics(amazonTop.price, ebayPrice, EBAY_DEFAULT_FEE_RATE)
      // Risk: bigger price → more return risk; mid-range is the sweet spot.
      const risk = amazonTop.price > 120 ? 'HIGH' : amazonTop.price > 60 ? 'MEDIUM' : 'LOW'

      itemsToUpsert.push({
        asin: amazonTop.asin,
        title: amazonTop.title,
        sourceProvider: 'demand-scout',
        sourceQuery: seed.query,
        sourceNiche: seed.niche,
        amazonPrice: amazonTop.price,
        ebayPrice,
        profit,
        roi,
        imageUrl: amazonTop.imageUrl,
        risk,
        salesVolume: undefined,
        _rating: amazonTop.rating || undefined,
        _numRatings: amazonTop.reviewCount || undefined,
        raw: {
          discoveredFrom: 'demand-scout',
          ebayDemandSignal: {
            seed: seed.query,
            ebayMinPrice,
            ebayItemId: hit.itemId,
            ebayTitle: hit.title,
            ebayPriceSeen: hit.price,
          },
        },
      })

      // Gentle pacing so we don't hammer Amazon mid-loop.
      await new Promise((r) => setTimeout(r, 350))
    }
  }

  if (itemsToUpsert.length > 0) {
    inserted = await upsertProductSourceItems(itemsToUpsert).catch(() => 0)
  }

  return { discovered: itemsToUpsert.length, considered, inserted, alreadyKnown, skipped, seeds: seeds.length }
}
