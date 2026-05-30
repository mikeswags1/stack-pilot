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
  const BATCH = 5

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const keywords = buildSearchKeywords(row.title)
        if (!keywords) return null
        const r = await queryEbayCompetition(keywords, token)
        return r ? { asin: row.asin, count: r.count, minPrice: r.minPrice } : null
      }),
    )

    for (const result of results) {
      if (result.status === 'rejected' || !result.value) {
        failed++
        continue
      }
      const { asin, count, minPrice } = result.value
      await sql`
        UPDATE product_source_items
        SET ebay_competitor_count = ${count},
            ebay_competitor_min_price = ${minPrice},
            last_intelligence_at = NOW()
        WHERE asin = ${asin}
      `.catch(() => {})
      enriched++
    }

    if (i + BATCH < rows.length) {
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  return { enriched, failed, skipped: 0 }
}
