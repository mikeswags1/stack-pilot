import { queryRows, sql } from '@/lib/db'
import { getMeaningfulTitleWords } from '@/lib/listing-quality'

const MAX_PER_RUN = 80
const COMPETITION_REFRESH_HOURS = 72

function buildSearchKeywords(title: string): string {
  const words = getMeaningfulTitleWords(title)
    .filter((w) => w.length > 2)
    .slice(0, 5)
  return words.join(' ')
}

async function queryEbayCompetitorCount(keywords: string, appId: string): Promise<number> {
  const url = new URL('https://svcs.ebay.com/services/search/FindingService/v1')
  url.searchParams.set('OPERATION-NAME', 'findItemsByKeywords')
  url.searchParams.set('SERVICE-VERSION', '1.0.0')
  url.searchParams.set('SECURITY-APPNAME', appId)
  url.searchParams.set('RESPONSE-DATA-FORMAT', 'JSON')
  url.searchParams.set('keywords', keywords)
  url.searchParams.set('itemFilter(0).name', 'ListingType')
  url.searchParams.set('itemFilter(0).value', 'FixedPrice')
  url.searchParams.set('paginationInput.entriesPerPage', '1')
  url.searchParams.set('paginationInput.pageNumber', '1')

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return -1

  const data = await res.json()
  const total = data?.findItemsByKeywordsResponse?.[0]?.paginationOutput?.[0]?.totalEntries?.[0]
  const count = parseInt(String(total || '0'), 10)
  return Number.isFinite(count) ? count : -1
}

export async function enrichCompetitionData(options: { limit?: number } = {}) {
  const appId = process.env.EBAY_APP_ID || ''
  if (!appId) return { enriched: 0, failed: 0, skipped: 0 }

  const limit = Math.max(1, Math.min(options.limit || MAX_PER_RUN, 200))

  const rows = await queryRows<{ asin: string; title: string }>`
    SELECT asin, title
    FROM product_source_items
    WHERE active = TRUE
      AND (
        ebay_competitor_count IS NULL
        OR last_seen_at > NOW() - (${COMPETITION_REFRESH_HOURS} * INTERVAL '1 hour')
          AND last_intelligence_at IS NOT NULL
          AND last_intelligence_at < NOW() - (${COMPETITION_REFRESH_HOURS} * INTERVAL '1 hour')
      )
    ORDER BY
      CASE WHEN ebay_competitor_count IS NULL THEN 0 ELSE 1 END,
      last_intelligence_at ASC NULLS FIRST,
      total_score DESC
    LIMIT ${limit}
  `.catch(() => [])

  let enriched = 0, failed = 0, skipped = 0
  const BATCH = 5

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const keywords = buildSearchKeywords(row.title)
        if (!keywords) return { asin: row.asin, count: -1 }
        const count = await queryEbayCompetitorCount(keywords, appId)
        return { asin: row.asin, count }
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') { failed++; continue }
      const { asin, count } = result.value
      if (count < 0) { failed++; continue }
      await sql`
        UPDATE product_source_items
        SET ebay_competitor_count = ${count}
        WHERE asin = ${asin}
      `.catch(() => {})
      enriched++
    }

    if (i + BATCH < rows.length) {
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  return { enriched, failed, skipped: rows.length === 0 ? 0 : skipped }
}
