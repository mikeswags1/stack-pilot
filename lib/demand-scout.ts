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

// Each seed may set priceMin/priceMax to search a specific eBay price shelf.
// ── Demand seeds — built from eBay Seller Hub SOURCING INSIGHTS (2026-07-03) ─────
// Top categories by search-to-listing ratio + sell-through rate over the last 30 days,
// filtered by our rules: dropshippable from Amazon Prime, no collectibles (coins/cards/
// memorabilia stay cut), no clothing/shoes (sizing returns), no handbags (authenticity).
//   Video Game Consoles  ratio 7.88  STR 17.7%  (GREAT)
//   Cell Phones          ratio 6.53  STR 12.1%  (GOOD — accessories only, phones = fraud)
//   Wristwatches         ratio 2.90  STR  4.6%
//   Golf Clubs           ratio 2.68  STR  7.4%  (GOOD)
//   Dolls & Playsets     ratio 1.74  STR  5.2%  (GOOD)
//   Action Figures       ratio 1.57  STR  6.1%  (GOOD)
//   Video Games          ratio 1.15  STR  7.8%
//   Party Gags & Tricks  eBay's "BEST OPPORTUNITY" pick for this account
//   Baby Carriers/Bags   ratio 1.14  STR  6.3%  (GREAT — bags/organizers angle)
const DEMAND_SEEDS: Array<{ niche: string; query: string; priceMin?: number; priceMax?: number }> = [
  // Video Game Consoles — eBay's #1 opportunity (7.88 ratio, 17.7% sell-through)
  { niche: 'Gaming', query: 'handheld game console retro' },
  { niche: 'Gaming', query: 'ps5 controller charging station' },
  { niche: 'Gaming', query: 'nintendo switch accessories kit' },
  { niche: 'Gaming', query: 'xbox controller battery pack' },
  { niche: 'Gaming', query: 'gaming headset wireless' },
  { niche: 'Gaming', query: 'switch carrying case' },
  { niche: 'Gaming', query: 'controller wall mount holder' },
  { niche: 'Gaming', query: 'racing wheel stand' },
  // Cell phone accessories — 6.53 ratio, 12.1% sell-through
  { niche: 'Phone Accessories', query: 'magsafe wireless charger stand' },
  { niche: 'Phone Accessories', query: 'phone case magnetic iphone' },
  { niche: 'Phone Accessories', query: 'screen protector privacy iphone' },
  { niche: 'Phone Accessories', query: 'power bank 20000mah fast charge' },
  { niche: 'Phone Accessories', query: 'car phone mount magnetic' },
  { niche: 'Phone Accessories', query: 'phone tripod stand ring light' },
  // Wristwatches — 11.1M searches, 2.90 ratio
  { niche: 'Watches', query: 'mens watch automatic skeleton' },
  { niche: 'Watches', query: 'digital sports watch men waterproof' },
  { niche: 'Watches', query: 'watch box organizer men' },
  { niche: 'Watches', query: 'watch band leather quick release' },
  { niche: 'Watches', query: 'womens watch rose gold bracelet' },
  // Golf — 2.68 ratio, 7.4% sell-through
  { niche: 'Golf', query: 'golf rangefinder slope' },
  { niche: 'Golf', query: 'golf practice net hitting mat' },
  { niche: 'Golf', query: 'golf grips midsize set' },
  { niche: 'Golf', query: 'golf balls used bulk' },
  { niche: 'Golf', query: 'golf push cart accessories' },
  { niche: 'Golf', query: 'putting green indoor mat' },
  // Dolls & playsets — 1.74 ratio (GOOD)
  { niche: 'Dolls & Toys', query: 'doll clothes 18 inch accessories' },
  { niche: 'Dolls & Toys', query: 'baby doll playset stroller' },
  { niche: 'Dolls & Toys', query: 'dollhouse furniture wooden' },
  // Action figures — 1.57 ratio (GOOD) — modern retail toys, NOT collectibles
  { niche: 'Action Figures', query: 'action figure display case stand' },
  { niche: 'Action Figures', query: 'dinosaur toys figures set' },
  { niche: 'Action Figures', query: 'robot action figure transforming' },
  // Video games adjacent — 1.15 ratio, 7.8% sell-through
  { niche: 'Gaming', query: 'game cartridge storage case' },
  { niche: 'Gaming', query: 'gaming mouse pad xl rgb' },
  // Party Gags & Tricks — eBay flagged BEST OPPORTUNITY for this account
  { niche: 'Party Supplies', query: 'prank kit funny gag gifts' },
  { niche: 'Party Supplies', query: 'magic trick set kids' },
  { niche: 'Party Supplies', query: 'party favors bulk kids' },
  { niche: 'Party Supplies', query: 'whoopee cushion self inflating' },
  // Baby carriers & bags — 1.14 ratio, 6.3% STR (bags/organizer angle, not safety gear)
  { niche: 'Baby', query: 'diaper bag backpack large' },
  { niche: 'Baby', query: 'stroller organizer caddy' },
  { niche: 'Baby', query: 'baby bag essentials organizer' },
  // ── From Mike's OWN 90-day sales history (added 2026-07-06) — proven buyers ──
  // Storage & garage was the standout ($382 parts cabinet, $157 truck bed organizer,
  // pegboard bins, wardrobe racks all sold). Display CASES sell repeatedly (cases are
  // allowed — only coins/cards themselves are banned). Replacement-parts angle sells
  // with low competition (foam cannon bottle, clipper blades).
  { niche: 'Storage & Garage', query: 'small parts organizer cabinet drawers' },
  { niche: 'Storage & Garage', query: 'truck bed storage organizer' },
  { niche: 'Storage & Garage', query: 'pegboard bins storage trays' },
  { niche: 'Storage & Garage', query: 'portable wardrobe closet organizer' },
  { niche: 'Display Cases', query: 'graded card display case wall mount' },
  { niche: 'Display Cases', query: 'acrylic display case shelf' },
  { niche: 'Tech Accessories', query: 'battery charging case iphone' },
  { niche: 'Tech Accessories', query: 'hdmi capture card usb streaming' },
  { niche: 'Tech Accessories', query: 'video doorbell camera wireless' },
  { niche: 'Tech Accessories', query: 'mechanical gaming keyboard wireless' },
  { niche: 'Outdoor & Fishing', query: 'telescopic fishing rod travel' },
  { niche: 'Outdoor & Fishing', query: 'misting fan rechargeable outdoor' },
  { niche: 'Outdoor & Fishing', query: 'camp kitchen organizer utensil' },
  { niche: 'Motorcycle Gear', query: 'motorcycle armor protective pads' },
  { niche: 'Motorcycle Gear', query: 'motorcycle gloves leather riding' },
  { niche: 'Replacement Parts', query: 'foam cannon replacement bottle parts' },
  { niche: 'Replacement Parts', query: 'pet clipper replacement blades' },
  // ── Big Ticket (added 2026-07-07, user: "get those bigger price listings up") ──
  // High-dollar practical items in his proven wheelhouse. These seeds search eBay's
  // $150-600 shelf (everyday seeds stay at $10-150). One sale here = 10-20 small ones.
  { niche: 'Big Ticket', query: 'rolling tool chest cabinet drawers', priceMin: 150, priceMax: 600 },
  { niche: 'Big Ticket', query: 'garage storage cabinet metal tall', priceMin: 150, priceMax: 600 },
  { niche: 'Big Ticket', query: 'heavy duty shelving unit garage', priceMin: 150, priceMax: 600 },
  { niche: 'Big Ticket', query: 'workbench with drawers garage', priceMin: 150, priceMax: 600 },
  { niche: 'Big Ticket', query: 'truck bed tool box', priceMin: 150, priceMax: 600 },
  { niche: 'Big Ticket', query: 'parts organizer cabinet industrial', priceMin: 150, priceMax: 600 },
  { niche: 'Big Ticket', query: 'wall mounted garage cabinet set', priceMin: 150, priceMax: 600 },
  { niche: 'Big Ticket', query: 'outdoor storage cabinet waterproof', priceMin: 150, priceMax: 600 },
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

// Performance-weighted seed selection ("never run out of supply"): half of each batch
// re-hunts the seeds that have historically PRODUCED inserts (exploit), the other half
// continues rotating through the full list so nothing goes unexplored (explore). Yield
// stats come from the scout's own trace — the system learns which niches feed the store.
async function nextSeedBatch(perRun: number): Promise<typeof DEMAND_SEEDS> {
  await ensureScoutCursor()

  const stats = await queryRows<{ seed_query: string; inserted: number; runs: number }>`
    SELECT seed_query,
      COUNT(*) FILTER (WHERE outcome = 'inserted')::int AS inserted,
      COUNT(DISTINCT run_id)::int AS runs
    FROM demand_scout_trace
    WHERE created_at > NOW() - INTERVAL '30 days' AND seed_query IS NOT NULL
    GROUP BY 1
  `.catch(() => [])
  const yieldBySeed = new Map(stats.map((s) => [s.seed_query, s.inserted / Math.max(1, s.runs)]))

  const exploitCount = Math.min(Math.floor(perRun / 2), DEMAND_SEEDS.length)
  const exploit = [...DEMAND_SEEDS]
    .filter((s) => (yieldBySeed.get(s.query) ?? 0) > 0)
    .sort((a, b) => (yieldBySeed.get(b.query) ?? 0) - (yieldBySeed.get(a.query) ?? 0))
    .slice(0, exploitCount)

  const rows = await queryRows<{ seed_cursor: number }>`SELECT seed_cursor FROM demand_scout_state WHERE id = 1`.catch(() => [])
  const start = (rows[0]?.seed_cursor ?? 0) % DEMAND_SEEDS.length
  const chosen = new Set(exploit.map((s) => s.query))
  const batch: typeof DEMAND_SEEDS = [...exploit]
  let advanced = 0
  for (let i = 0; batch.length < perRun && i < DEMAND_SEEDS.length; i++) {
    const seed = DEMAND_SEEDS[(start + i) % DEMAND_SEEDS.length]
    advanced = i + 1
    if (chosen.has(seed.query)) continue
    chosen.add(seed.query)
    batch.push(seed)
  }
  const next = (start + advanced) % DEMAND_SEEDS.length
  await sql`UPDATE demand_scout_state SET seed_cursor = ${next}, updated_at = NOW() WHERE id = 1`.catch(() => {})
  return batch
}

type EbayHit = { title: string; price: number; itemId: string; imageUrl: string }

async function searchEbayDemand(query: string, token: string, limit = 15, priceMin = 10, priceMax = 150): Promise<EbayHit[]> {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  url.searchParams.set('q', query)
  // BEST_MATCH ranks by eBay's own demand signal (sales velocity weighted), so the top
  // results ARE the demand signal — exactly what we want to mirror on our side.
  // Price window is per-seed: default [10..150] for everyday items; Big Ticket seeds
  // pass [150..600] — before 7/7 the hardcoded $150 cap made $200+ items INVISIBLE.
  url.searchParams.set('filter', `buyingOptions:{FIXED_PRICE},conditions:{NEW},priceCurrency:USD,price:[${priceMin}..${priceMax}]`)
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
    const hits = await searchEbayDemand(seed.query, token, perSeed, seed.priceMin, seed.priceMax)
    if (hits.length === 0) {
      await trace(runId, { outcome: 'browse_empty', seed_query: seed.query, reason: 'Browse API returned 0 hits (rate-limit, filter mismatch, or genuinely no inventory)' })
      continue
    }

    // Min competitor price for this seed = the bottom-of-market reference.
    const ebayMinPrice = Math.min(...hits.map((h) => h.price))

    // Source a rotating 7-hit window (1-7, then 8-14, then 15-21 across consecutive
    // hunts). Fixed slice(0,7) made every hunt re-examine the SAME top results —
    // 25% of daily candidates were repeat sightings of already-known products.
    // Deeper hits carry slightly weaker demand signal but are FRESH.
    const windowIndex = Math.floor(Date.now() / (4 * 3600 * 1000)) % 3
    const windowStart = windowIndex * 7
    const hitWindow = hits.length > windowStart ? hits.slice(windowStart, windowStart + 7) : hits.slice(0, 7)
    for (const hit of hitWindow) {
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

      // Margin gate vs THIS listing's own eBay price — not the seed's minimum. The seed
      // min compares apples to oranges (a $150 Browning camera vs some $19 junk camera in
      // the same niche) and rejected every real match. hit.price is what THIS product
      // demonstrably sells for on eBay right now — the actual arbitrage question.
      if (!isViableProduct(amazonTop.price, hit.price, amazonTop.title)) {
        skipped++
        const ratio = (amazonTop.price / hit.price).toFixed(2)
        const reason = amazonTop.price < 8
          ? `Amazon price $${amazonTop.price} below $8 floor`
          : amazonTop.price > hit.price * MAX_AMAZON_COST_RATIO
            ? `Amazon $${amazonTop.price} > ${MAX_AMAZON_COST_RATIO} × this listing's eBay $${hit.price} (ratio ${ratio})`
            : isWeakListingTitle(amazonTop.title)
              ? 'Amazon title flagged as weak/junk'
              : 'Amazon title matched listing-policy blocklist'
        await trace(runId, { ...candidate, outcome: 'viability_failed', reason })
        continue
      }
      await trace(runId, { ...candidate, outcome: 'inserted' })

      const ebayPrice = getRecommendedEbayPrice(amazonTop.price, EBAY_DEFAULT_FEE_RATE)
      const { profit, roi } = getListingMetrics(amazonTop.price, ebayPrice, EBAY_DEFAULT_FEE_RATE)
      // Risk bands loosened 7/7 per Mike: his sales history proves big practical items
      // (parts cabinets, truck organizers) are top earners — HIGH (blocked from
      // enrichment) now only above $300 Amazon cost; $120-300 is MEDIUM.
      const risk = amazonTop.price > 300 ? 'HIGH' : amazonTop.price > 120 ? 'MEDIUM' : 'LOW'

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
