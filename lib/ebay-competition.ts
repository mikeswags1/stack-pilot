// eBay competition enrichment — uses the Browse API (modern, OAuth client-credentials,
// generous quota) to count and price-check competing listings for each active product.
// Replaced the old Finding API path which was silently failing with rate-limit errors
// (svcs.ebay.com 10001 "Service call has exceeded the number of times allowed"), leaving
// 99% of the pool with no competition data.
import { queryRows, sql } from '@/lib/db'
import { getMeaningfulTitleWords } from '@/lib/listing-quality'
import { getEbayAppToken } from '@/lib/ebay-app-token'

const MAX_PER_RUN = 80

function buildSearchKeywords(title: string): string {
  const words = getMeaningfulTitleWords(title)
    .filter((w) => w.length > 2)
    .slice(0, 5)
  return words.join(' ')
}

type BrowseSummary = {
  total?: number
  itemSummaries?: Array<{ price?: { value?: string; currency?: string } }>
}

// Returns { count: total matching active fixed-price US listings, minPrice: lowest price
// among the first page of results } or null on failure. minPrice is null if no prices found.
async function queryEbayCompetition(
  keywords: string,
  token: string,
): Promise<{ count: number; minPrice: number | null } | null> {
  const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
  url.searchParams.set('q', keywords)
  url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW}')
  url.searchParams.set('limit', '10')
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null)
  if (!res || !res.ok) return null
  const data = (await res.json().catch(() => null)) as BrowseSummary | null
  if (!data) return null
  const count = typeof data.total === 'number' ? data.total : 0
  const prices = (data.itemSummaries || [])
    .map((it) => parseFloat(String(it?.price?.value || '0')))
    .filter((p) => Number.isFinite(p) && p > 0)
  const minPrice = prices.length > 0 ? Math.min(...prices) : null
  return { count, minPrice }
}

type BrowseSearchWithIds = {
  total?: number
  itemSummaries?: Array<{ itemId?: string; price?: { value?: string } }>
}

/**
 * SELL-THROUGH ENRICHMENT (2026-06-11). For market-survivor products (the only ones
 * worth the budget), fetch the top competitor listings and read eBay's official
 * estimatedSoldQuantity from Browse getItem — the same "X sold" number buyers see.
 * Sum across the top 3 = a comparative demand signal: how fast comparable items
 * ACTUALLY sell on eBay. Stored on product_source_items.ebay_sold_velocity and fed
 * into the product score so fast movers rank first in the queue.
 * Cost: ~4 Browse calls per product at 700ms pacing — limit 12/run ≈ 35s, well
 * inside the burst threshold and daily cap (especially after the saturated-pool
 * retirement freed most of the enricher's old spend).
 */
export async function enrichSellThroughData(options: { limit?: number } = {}) {
  const token = await getEbayAppToken()
  if (!token) return { enriched: 0, failed: 0 }

  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS ebay_sold_velocity INTEGER`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS ebay_sold_velocity_checked_at TIMESTAMPTZ`.catch(() => {})

  const limit = Math.max(1, Math.min(options.limit || 12, 40))
  const rows = await queryRows<{ asin: string; title: string }>`
    SELECT asin, title
    FROM product_source_items
    WHERE active = TRUE
      AND ebay_competitor_count IS NOT NULL
      AND ebay_competitor_count BETWEEN 1 AND 50
      AND (ebay_competitor_min_price IS NULL OR amazon_price < ebay_competitor_min_price * 1.65)
      AND (ebay_sold_velocity_checked_at IS NULL OR ebay_sold_velocity_checked_at < NOW() - INTERVAL '14 days')
    ORDER BY ebay_sold_velocity_checked_at ASC NULLS FIRST, total_score DESC NULLS LAST
    LIMIT ${limit}
  `.catch(() => [] as Array<{ asin: string; title: string }>)

  let enriched = 0
  let failed = 0
  for (const row of rows) {
    const keywords = buildSearchKeywords(row.title)
    if (!keywords) { failed++; continue }

    const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
    url.searchParams.set('q', keywords)
    url.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},conditions:{NEW}')
    url.searchParams.set('limit', '3')
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null)
    if (!res || !res.ok) { failed++; await new Promise((r) => setTimeout(r, 700)); continue }
    const data = (await res.json().catch(() => null)) as BrowseSearchWithIds | null
    const itemIds = (data?.itemSummaries || []).map((it) => it.itemId).filter((id): id is string => Boolean(id))

    let soldSum = 0
    for (const itemId of itemIds) {
      const itemRes = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
        signal: AbortSignal.timeout(8000),
      }).catch(() => null)
      if (itemRes?.ok) {
        const item = (await itemRes.json().catch(() => null)) as {
          estimatedAvailabilities?: Array<{ estimatedSoldQuantity?: number }>
        } | null
        for (const avail of item?.estimatedAvailabilities || []) {
          if (typeof avail.estimatedSoldQuantity === 'number') {
            // Cap per-listing so one mega-listing can't distort the comparative signal.
            soldSum += Math.min(avail.estimatedSoldQuantity, 5000)
          }
        }
      }
      await new Promise((r) => setTimeout(r, 700))
    }

    await sql`
      UPDATE product_source_items
      SET ebay_sold_velocity = ${soldSum},
          ebay_sold_velocity_checked_at = NOW()
      WHERE asin = ${row.asin}
    `.catch(() => {})
    enriched++
    await new Promise((r) => setTimeout(r, 700))
  }

  return { enriched, failed }
}

export async function enrichCompetitionData(options: { limit?: number } = {}) {
  const token = await getEbayAppToken()
  if (!token) return { enriched: 0, failed: 0, skipped: 0 }

  // Self-installing schema: add the min-price column once. Cheap when it already exists.
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS ebay_competitor_min_price NUMERIC(10,2)`.catch(() => {})

  const limit = Math.max(1, Math.min(options.limit || MAX_PER_RUN, 200))

  // Prioritize products that have NEVER been checked. Once that backlog is drained, the
  // outcome-tracker or refresh cron can re-call with a stale-refresh strategy.
  const rows = await queryRows<{ asin: string; title: string }>`
    SELECT asin, title
    FROM product_source_items
    WHERE active = TRUE
      AND ebay_competitor_count IS NULL
    ORDER BY total_score DESC NULLS LAST
    LIMIT ${limit}
  `.catch(() => [] as Array<{ asin: string; title: string }>)

  let enriched = 0
  let failed = 0
  // Throttle: eBay Browse API enforces burst protection (429 "request limit has been
  // reached") long before the daily 5k cap. Sequential calls with a 600ms delay keeps
  // us well under the burst threshold. ~80/run × this pacing finishes in ~50s.
  for (const row of rows) {
    const keywords = buildSearchKeywords(row.title)
    if (!keywords) { failed++; continue }
    const r = await queryEbayCompetition(keywords, token)
    if (!r) { failed++; continue }
    await sql`
      UPDATE product_source_items
      SET ebay_competitor_count = ${r.count},
          ebay_competitor_min_price = ${r.minPrice},
          last_intelligence_at = NOW()
      WHERE asin = ${row.asin}
    `.catch(() => {})
    enriched++
    await new Promise((res) => setTimeout(res, 600))
  }

  return { enriched, failed, skipped: 0 }
}
