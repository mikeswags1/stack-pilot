import { queryRows, sql } from '@/lib/db'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { EBAY_DEFAULT_FEE_RATE, MIN_NET_PROFIT, getNetProfit, getRecommendedEbayPrice, priceForNetProfit } from '@/lib/listing-pricing'

const REPRICE_MIN_DELTA_USD = 0.5
const REPRICE_MIN_DELTA_PCT = 3
const MAX_PER_RUN = 300

type RepriceRow = {
  user_id: number
  ebay_listing_id: string
  asin: string | null
  listed_amazon_price: string | number | null
  ebay_price: string | number | null
  ebay_fee_rate: string | number | null
  current_amazon_price: string | number | null
  below_net_floor_at: string | null
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function roundUpToEnding99(value: number) {
  let price = Math.floor(value) + 0.99
  if (price < value) price += 1
  return Number(price.toFixed(2))
}

async function ensureRepriceColumns() {
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS last_repriced_at TIMESTAMPTZ`.catch(() => {})
  // Set by the tiered listing audit when a fresh Amazon price shows this listing's net
  // profit is below MIN_NET_PROFIT at its current eBay price. The reprice agent treats
  // flagged listings as URGENT: they jump the rotation, bypass the 2h cooldown, and the
  // flag clears once the price is lifted back above the floor.
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS below_net_floor_at TIMESTAMPTZ`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listed_asins_reprice_idx ON listed_asins (ended_at, last_repriced_at)`.catch(() => {})
}

async function ensureRepriceLogTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS reprice_agent_log (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      ebay_listing_id TEXT NOT NULL,
      asin TEXT,
      old_ebay_price NUMERIC(10,2),
      new_ebay_price NUMERIC(10,2),
      old_amazon_price NUMERIC(10,2),
      new_amazon_price NUMERIC(10,2),
      dry_run BOOLEAN NOT NULL DEFAULT FALSE,
      success BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS reprice_log_created_idx ON reprice_agent_log (created_at DESC)`.catch(() => {})
}

async function reviseEbayPrice(
  listingId: string,
  accessToken: string,
  newPrice: number,
  appId: string
): Promise<boolean> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken></RequesterCredentials>
  <Item>
    <ItemID>${listingId}</ItemID>
    <StartPrice>${newPrice.toFixed(2)}</StartPrice>
  </Item>
</ReviseFixedPriceItemRequest>`

  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-APP-NAME': appId,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'text/xml',
    },
    body: xml,
    signal: AbortSignal.timeout(10000),
  })
  const text = await res.text()
  return /<Ack>(Success|Warning)<\/Ack>/i.test(text)
}

export async function runRepriceAgent(options: { dryRun?: boolean; userId?: number } = {}) {
  const startedAt = Date.now()
  await ensureRepriceColumns()
  await ensureRepriceLogTable()

  const rows = options.userId
    ? await queryRows<RepriceRow>`
        SELECT
          la.user_id,
          la.ebay_listing_id,
          la.asin,
          la.amazon_price AS listed_amazon_price,
          la.ebay_price,
          la.ebay_fee_rate,
          COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price) AS current_amazon_price,
          la.below_net_floor_at
        FROM listed_asins la
        LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(la.asin)
        WHERE la.ended_at IS NULL
          AND la.ebay_listing_id IS NOT NULL
          AND la.asin IS NOT NULL
          AND la.amazon_price IS NOT NULL
          AND la.amazon_price > 0
          AND la.ebay_price IS NOT NULL
          AND la.ebay_price > 0
          -- A cache row with amazon_price = 0 was written by a bot-blocked scrape:
          -- BOTH its price and its available flag are noise. Treat the row as
          -- unknown and fall back to the list-time cost so the listing still
          -- gets repriced (0.00 is not NULL, so plain COALESCE excluded ~2,170
          -- live listings from repricing entirely).
          AND (COALESCE(apc.available, TRUE) <> FALSE OR apc.amazon_price = 0)
          AND COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price) > 0
          AND (la.last_repriced_at IS NULL OR la.last_repriced_at < NOW() - INTERVAL '2 hours' OR la.below_net_floor_at IS NOT NULL)
          AND la.user_id = ${options.userId}
        ORDER BY (la.below_net_floor_at IS NOT NULL) DESC, la.last_repriced_at ASC NULLS FIRST
        LIMIT ${MAX_PER_RUN}
      `.catch(() => [])
    : await queryRows<RepriceRow>`
        SELECT
          la.user_id,
          la.ebay_listing_id,
          la.asin,
          la.amazon_price AS listed_amazon_price,
          la.ebay_price,
          la.ebay_fee_rate,
          COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price) AS current_amazon_price,
          la.below_net_floor_at
        FROM listed_asins la
        LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(la.asin)
        WHERE la.ended_at IS NULL
          AND la.ebay_listing_id IS NOT NULL
          AND la.asin IS NOT NULL
          AND la.amazon_price IS NOT NULL
          AND la.amazon_price > 0
          AND la.ebay_price IS NOT NULL
          AND la.ebay_price > 0
          -- A cache row with amazon_price = 0 was written by a bot-blocked scrape:
          -- BOTH its price and its available flag are noise. Treat the row as
          -- unknown and fall back to the list-time cost so the listing still
          -- gets repriced (0.00 is not NULL, so plain COALESCE excluded ~2,170
          -- live listings from repricing entirely).
          AND (COALESCE(apc.available, TRUE) <> FALSE OR apc.amazon_price = 0)
          AND COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price) > 0
          AND (la.last_repriced_at IS NULL OR la.last_repriced_at < NOW() - INTERVAL '2 hours' OR la.below_net_floor_at IS NOT NULL)
        ORDER BY (la.below_net_floor_at IS NOT NULL) DESC, la.last_repriced_at ASC NULLS FIRST
        LIMIT ${MAX_PER_RUN}
      `.catch(() => [])

  const appId = process.env.EBAY_APP_ID || ''
  const credCache = new Map<number, string | null>()
  let revised = 0, skipped = 0, failed = 0

  for (const row of rows) {
    const currentAmazonPrice = Number(row.current_amazon_price || 0)
    const currentEbayPrice = Number(row.ebay_price || 0)
    const feeRate = row.ebay_fee_rate ? Number(row.ebay_fee_rate) : EBAY_DEFAULT_FEE_RATE

    if (currentAmazonPrice <= 0 || currentEbayPrice <= 0) { skipped++; continue }

    const recommendedPrice = getRecommendedEbayPrice(currentAmazonPrice, feeRate)
    const netFloorPrice = roundUpToEnding99(priceForNetProfit(currentAmazonPrice, MIN_NET_PROFIT, { feeRate }))
    const optimalPrice = Math.max(recommendedPrice, netFloorPrice)
    const projectedNet = getNetProfit(currentAmazonPrice, optimalPrice, { feeRate })
    if (projectedNet < MIN_NET_PROFIT) { skipped++; continue }
    const delta = Math.abs(optimalPrice - currentEbayPrice)
    const deltaPct = (delta / currentEbayPrice) * 100

    if (delta < REPRICE_MIN_DELTA_USD && deltaPct < REPRICE_MIN_DELTA_PCT) {
      // Flagged but the optimal price is within noise of the current price — the
      // listing is effectively at/above the floor already. Clear the stale flag so
      // it stops jumping the rotation (the audit re-flags if it drifts again).
      if (row.below_net_floor_at && !options.dryRun) {
        await sql`
          UPDATE listed_asins SET below_net_floor_at = NULL
          WHERE user_id = ${Number(row.user_id)} AND ebay_listing_id = ${row.ebay_listing_id}
        `.catch(() => {})
      }
      skipped++; continue
    }

    const userId = Number(row.user_id)

    if (!credCache.has(userId)) {
      const creds = await getValidEbayAccessToken(String(userId)).catch(() => null)
      credCache.set(userId, creds?.accessToken || null)
    }
    const token = credCache.get(userId)
    if (!token) { skipped++; continue }

    if (options.dryRun) { revised++; continue }

    try {
      const ok = await reviseEbayPrice(row.ebay_listing_id, token, optimalPrice, appId)
      if (ok) {
        revised++
        await sql`
          UPDATE listed_asins
          SET ebay_price = ${optimalPrice},
              amazon_price = ${currentAmazonPrice},
              last_repriced_at = NOW(),
              below_net_floor_at = NULL
          WHERE user_id = ${userId}
            AND ebay_listing_id = ${row.ebay_listing_id}
        `.catch(() => {})
        await sql`
          INSERT INTO reprice_agent_log (
            user_id, ebay_listing_id, asin,
            old_ebay_price, new_ebay_price,
            old_amazon_price, new_amazon_price,
            dry_run, success
          )
          VALUES (
            ${userId}, ${row.ebay_listing_id}, ${row.asin},
            ${currentEbayPrice}, ${optimalPrice},
            ${Number(row.listed_amazon_price || 0)}, ${currentAmazonPrice},
            FALSE, TRUE
          )
        `.catch(() => {})
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }

  return {
    checked: rows.length,
    revised,
    skipped,
    failed,
    durationMs: Date.now() - startedAt,
    dryRun: options.dryRun || false,
  }
}

export async function getRecentRepriceLogs(limit = 20) {
  await ensureRepriceLogTable()
  return queryRows<{
    id: string | number
    user_id: number
    ebay_listing_id: string
    asin: string | null
    old_ebay_price: string | number | null
    new_ebay_price: string | number | null
    success: boolean
    created_at: string | null
  }>`
    SELECT id, user_id, ebay_listing_id, asin,
           old_ebay_price, new_ebay_price, success, created_at
    FROM reprice_agent_log
    ORDER BY created_at DESC
    LIMIT ${Math.max(1, Math.min(100, limit))}
  `.catch(() => [])
}
