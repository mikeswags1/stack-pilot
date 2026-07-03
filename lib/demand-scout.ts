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
import { getMeaningfulTitleWords, isWeakListingTitle } from '@/lib/listing-quality'
import { hasBlockedListingPolicyFlag, getListingPolicyFlags } from '@/lib/listing-policy'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getRecommendedEbayPrice } from '@/lib/listing-pricing'
import { upsertProductSourceItems } from '@/lib/product-source-engine'
import { getRapidApiKey } from '@/lib/rapidapi'

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

// Reduce a noisy eBay title to a clean 5-keyword Amazon search query. eBay listings
// stuff titles with brand-bait keywords ("USB Charging Station, 10 USB Fast Ports
// Charge Docking Station and Adjustable..."); Amazon search treats those as exact-AND
// and returns nothing. The meaningful-words helper strips stopwords/punct, then we
// take the first 5 — enough to find the matching product, not so noisy it gets 0 hits.
function ebayTitleToAmazonQuery(ebayTitle: string): string {
  const words = getMeaningfulTitleWords(ebayTitle)
    .filter((w) => w.length > 2)
    .slice(0, 5)
  return words.join(' ')
}

// Fallback Amazon search via the paid RapidAPI when the free scraper returns nothing
// (Amazon's anti-bot is harder on search than on product pages, especially from
// datacenter IPs). Returns the first reasonable ASIN+title+price+image or null.
async function searchAmazonViaRapidApi(query: string): Promise<{ asin: string; title: string; price: number; imageUrl: string; rating?: number; reviewCount?: number } | null> {
  const key = getRapidApiKey()
  if (!key) return null
  const url = `https://real-time-amazon-data.p.rapidapi.com/search?query=${encodeURIComponent(query)}&country=US&category_id=aps&page=1`
  const res = await fetch(url, {
    headers: { 'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com', 'x-rapidapi-key': key },
    signal: AbortSignal.timeout(10000),
  }).catch(() => null)
  if (!res || !res.ok) return null
  type Hit = { asin?: string; product_title?: string; product_price?: string; product_photo?: string; product_star_rating?: string; product_num_ratings?: number }
  const j = (await res.json().catch(() => null)) as { data?: { products?: Hit[] } } | null
  const products = j?.data?.products || []
  for (const p of products) {
    const asin = String(p?.asin || '').toUpperCase().trim()
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue
    const price = parseFloat(String(p?.product_price || '').replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(price) || price <= 0) continue
    const title = String(p?.product_title || '').trim()
    if (!title) continue
    return {
      asin,
      title,
      price,
      imageUrl: String(p?.product_photo || ''),
      rating: p?.product_star_rating ? parseFloat(p.product_star_rating) : undefined,
      reviewCount: p?.product_num_ratings,
    }
  }
  return null
}

// Reliable paid fallback: ScraperAPI structured Amazon search (the same funded feed the
// cleanup audit uses). Prefers Prime results — non-Prime sources fail our listing rules
// downstream anyway. Quota-gated at the shared scraperapi daily cap (see quota-tracker).
async function searchAmazonViaScraperApi(query: string): Promise<{ asin: string; title: string; price: number; imageUrl: string; rating?: number; reviewCount?: number } | null> {
  const key = String(process.env.SCRAPERAPI_KEY || '').trim()
  if (!key) return null

  const { recordApiCall, getThrottleState } = await import('@/lib/quota-tracker')
  const throttle = await getThrottleState('scraperapi', 'structured-search').catch(() => 'ok' as const)
  if (throttle === 'block') return null

  const startedAt = Date.now()
  const url = `https://api.scraperapi.com/structured/amazon/search?api_key=${key}&query=${encodeURIComponent(query)}&country=us`
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) }).catch(() => null)
  if (!res || !res.ok) {
    recordApiCall({ provider: 'scraperapi', callName: 'structured-search', success: false, durationMs: Date.now() - startedAt, errorCode: res ? `HTTP_${res.status}` : 'NETWORK' }).catch(() => {})
    return null
  }
  type Hit = { asin?: string; name?: string; price?: number; price_string?: string; image?: string; stars?: number; total_reviews?: number; has_prime?: boolean; type?: string }
  const j = (await res.json().catch(() => null)) as { results?: Hit[] } | null
  recordApiCall({ provider: 'scraperapi', callName: 'structured-search', success: true, durationMs: Date.now() - startedAt }).catch(() => {})

  const toCandidate = (p: Hit) => {
    const asin = String(p?.asin || '').toUpperCase().trim()
    if (!/^[A-Z0-9]{10}$/.test(asin)) return null
    const price = Number.isFinite(p?.price) && Number(p?.price) > 0
      ? Number(p?.price)
      : parseFloat(String(p?.price_string || '').replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(price) || price <= 0) return null
    const title = String(p?.name || '').trim()
    if (!title) return null
    return {
      asin,
      title,
      price,
      imageUrl: String(p?.image || ''),
      rating: Number.isFinite(p?.stars) ? Number(p?.stars) : undefined,
      reviewCount: Number.isFinite(p?.total_reviews) ? Number(p?.total_reviews) : undefined,
    }
  }
  const results = (j?.results || []).slice(0, 8)
  // Prime results first — they're the only ones that pass our fulfillment rules.
  for (const p of results) { if (p?.has_prime) { const c = toCandidate(p); if (c) return c } }
  for (const p of results) { const c = toCandidate(p); if (c) return c }
  return null
}

// ── Observability — every candidate's full pipeline trace is written here so we
// can see exactly where the scout funnel is breaking. Outcomes: 'browse_empty',
// 'policy_blocked', 'amazon_query_empty', 'amazon_not_found', 'already_known',
// 'viability_failed', 'inserted'.
async function ensureScoutTraceTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS demand_scout_trace (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      outcome TEXT NOT NULL,
      seed_query TEXT,
      ebay_title TEXT,
      ebay_min_price NUMERIC(10,2),
      amazon_query TEXT,
      amazon_asin TEXT,
      amazon_price NUMERIC(10,2),
      amazon_title TEXT,
      amazon_source TEXT,
      margin_ratio NUMERIC(6,3),
      reason TEXT
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS demand_scout_trace_run_idx ON demand_scout_trace (run_id)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS demand_scout_trace_outcome_idx ON demand_scout_trace (outcome, created_at DESC)`.catch(() => {})
}

type TraceRow = {
  outcome: 'browse_empty' | 'policy_blocked' | 'amazon_query_empty' | 'amazon_not_found' | 'already_known' | 'viability_failed' | 'inserted'
  seed_query: string
  ebay_title?: string
  ebay_min_price?: number | null
  amazon_query?: string | null
  amazon_asin?: string | null
  amazon_price?: number | null
  amazon_title?: string | null
  amazon_source?: 'scrape' | 'scraperapi' | 'rapidapi' | 'none' | null
  reason?: string | null
}

async function trace(runId: string, row: TraceRow) {
  const marginRatio = row.amazon_price && row.ebay_min_price
    ? Number((row.amazon_price / row.ebay_min_price).toFixed(3))
    : null
  await sql`
    INSERT INTO demand_scout_trace (
      run_id, outcome, seed_query, ebay_title, ebay_min_price,
      amazon_query, amazon_asin, amazon_price, amazon_title, amazon_source,
      margin_ratio, reason
    ) VALUES (
      ${runId}, ${row.outcome}, ${row.seed_query}, ${row.ebay_title ?? null}, ${row.ebay_min_price ?? null},
      ${row.amazon_query ?? null}, ${row.amazon_asin ?? null}, ${row.amazon_price ?? null},
      ${row.amazon_title ?? null}, ${row.amazon_source ?? null},
      ${marginRatio}, ${row.reason ?? null}
    )
  `.catch(() => {})
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
  if (!token) return { discovered: 0, considered: 0, inserted: 0, alreadyKnown: 0, skipped: 0, seeds: 0, runId: null }

  await ensureScoutTraceTable()
  const runId = `r${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const seeds = await nextSeedBatch(seedsPerRun)

  let considered = 0
  let inserted = 0
  let alreadyKnown = 0
  let skipped = 0
  const itemsToUpsert: Parameters<typeof upsertProductSourceItems>[0] = []

  for (const seed of seeds) {
    // Pace Browse API calls — eBay enforces burst protection (429) before the daily cap.
    if (seeds.indexOf(seed) > 0) await new Promise((r) => setTimeout(r, 700))
    const hits = await searchEbayDemand(seed.query, token, perSeed)
    if (hits.length === 0) {
      await trace(runId, { outcome: 'browse_empty', seed_query: seed.query, reason: 'Browse API returned 0 hits (rate-limit, filter mismatch, or genuinely no inventory)' })
      continue
    }

    // Min competitor price for this seed = the bottom-of-market reference.
    const ebayMinPrice = Math.min(...hits.map((h) => h.price))

    // Look at the top ~5 hits (best demand signal) and try to source each from Amazon.
    for (const hit of hits.slice(0, 5)) {
      considered++
      const base: Pick<TraceRow, 'seed_query' | 'ebay_title' | 'ebay_min_price'> = {
        seed_query: seed.query, ebay_title: hit.title, ebay_min_price: ebayMinPrice,
      }

      if (hasBlockedListingPolicyFlag(getListingPolicyFlags({ title: hit.title }))) {
        skipped++
        await trace(runId, { ...base, outcome: 'policy_blocked', reason: 'eBay title matched listing-policy blocklist (oversized/fragile/etc.)' })
        continue
      }

      // Reduce the noisy eBay title to a clean 5-keyword query — both for scrape and
      // for the RapidAPI fallback. Without this, Amazon returns 0 hits for most queries.
      const amazonQuery = ebayTitleToAmazonQuery(hit.title)
      if (!amazonQuery) {
        skipped++
        await trace(runId, { ...base, outcome: 'amazon_query_empty', reason: 'getMeaningfulTitleWords produced no usable query' })
        continue
      }

      // Try free scrape first; fall back to ScraperAPI (paid, reliable), then RapidAPI
      // (dead key — returns null instantly) when Amazon blocks the scrape.
      let amazonTop: { asin: string; title: string; price: number; imageUrl: string; rating?: number; reviewCount?: number } | null = null
      let amazonSource: 'scrape' | 'scraperapi' | 'rapidapi' | 'none' = 'none'
      const scraped = await scrapeAmazonSearch(amazonQuery).catch(() => [])
      if (scraped[0]?.asin && scraped[0]?.title && scraped[0]?.price > 0) {
        amazonTop = scraped[0]
        amazonSource = 'scrape'
      } else {
        amazonTop = await searchAmazonViaScraperApi(amazonQuery)
        if (amazonTop) {
          amazonSource = 'scraperapi'
        } else {
          amazonTop = await searchAmazonViaRapidApi(amazonQuery)
          if (amazonTop) amazonSource = 'rapidapi'
        }
      }
      if (!amazonTop) {
        skipped++
        await trace(runId, { ...base, outcome: 'amazon_not_found', amazon_query: amazonQuery, amazon_source: 'none', reason: `Scrape, ScraperAPI, and RapidAPI all returned 0 valid Amazon results for query "${amazonQuery}"` })
        continue
      }

      const candidate = { ...base, amazon_query: amazonQuery, amazon_asin: amazonTop.asin, amazon_price: amazonTop.price, amazon_title: amazonTop.title, amazon_source: amazonSource }

      // Already in pool? Skip — existing pipeline handles it.
      const exists = await queryRows<{ asin: string }>`SELECT asin FROM product_source_items WHERE asin = ${amazonTop.asin} LIMIT 1`.catch(() => [])
      if (exists.length > 0) {
        alreadyKnown++
        await trace(runId, { ...candidate, outcome: 'already_known', reason: 'ASIN already in product_source_items' })
        continue
      }

      if (!isViableProduct(amazonTop.price, ebayMinPrice, amazonTop.title)) {
        skipped++
        const ratio = (amazonTop.price / ebayMinPrice).toFixed(2)
        const reason = amazonTop.price < 8
          ? `Amazon price $${amazonTop.price} below $8 floor`
          : amazonTop.price > ebayMinPrice * MAX_AMAZON_COST_RATIO
            ? `Amazon $${amazonTop.price} > ${MAX_AMAZON_COST_RATIO} × eBay min $${ebayMinPrice} (ratio ${ratio})`
            : isWeakListingTitle(amazonTop.title)
              ? 'Amazon title flagged as weak/junk'
              : 'Amazon title matched listing-policy blocklist'
        await trace(runId, { ...candidate, outcome: 'viability_failed', reason })
        continue
      }
      await trace(runId, { ...candidate, outcome: 'inserted' })

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

  return { discovered: itemsToUpsert.length, considered, inserted, alreadyKnown, skipped, seeds: seeds.length, runId }
}
