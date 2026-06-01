// Phase 2 — Listing outcome tracking.
//
// Pulls real-world eBay outcomes for every listing and writes them back to listed_asins:
//   - Sales (sold_at, sale_price, quantity_sold)            — from /sell/fulfillment/v1/order
//   - Cancellations & refunds                                — from order detail
//   - Engagement (watch_count, hit_count)                    — from Trading API GetItem
//   - Price reductions (reduction_count)                     — derived from reprice_agent_log
//
// Designed to be cheap + quota-aware. Sale-pull uses the Sell API (separate quota from Trading
// API). Engagement-pull uses Trading API GetItem (shares the listing quota bucket) — so we
// batch + throttle it and skip when the global quota gate is in warn/block.

import { queryRows, sql } from '@/lib/db'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { recordApiCall, getThrottleState } from '@/lib/quota-tracker'

// ────────────────────────────── Schema ──────────────────────────────

export async function ensureListingOutcomeColumns() {
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS sale_price NUMERIC(10,2)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS quantity_sold INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS realized_profit NUMERIC(10,2)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS cancel_count INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS refund_count INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS watch_count INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS hit_count INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS engagement_checked_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS reduction_count INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS relist_count INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS performance_score NUMERIC(6,2)`.catch(() => {})
  await sql`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS performance_updated_at TIMESTAMPTZ`.catch(() => {})

  await sql`CREATE INDEX IF NOT EXISTS listed_asins_sold_idx ON listed_asins (sold_at DESC NULLS LAST)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listed_asins_performance_idx ON listed_asins (performance_score DESC NULLS LAST)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listed_asins_niche_sold_idx ON listed_asins (niche, sold_at DESC NULLS LAST)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listed_asins_engagement_due_idx ON listed_asins (engagement_checked_at NULLS FIRST) WHERE ended_at IS NULL`.catch(() => {})
}

// ────────────────────────────── eBay Sell API: orders ──────────────────────────────

type EbayOrderLineItem = {
  lineItemId?: string
  legacyItemId?: string
  itemId?: string
  title?: string
  quantity?: number
  lineItemCost?: { value?: string; currency?: string }
  total?: { value?: string; currency?: string }
}

type EbayOrder = {
  orderId: string
  creationDate?: string
  orderFulfillmentStatus?: string
  orderPaymentStatus?: string
  cancelStatus?: { cancelState?: string; cancelledDate?: string }
  pricingSummary?: { total?: { value?: string } }
  lineItems?: EbayOrderLineItem[]
}

async function fetchCompletedOrders(
  base: string,
  accessToken: string,
  daysBack: number,
): Promise<EbayOrder[]> {
  // Pull orders modified in the last N days. We rely on creationDate filter so we don't repeat
  // the same orders forever. eBay returns at most 200/request; for a single store this is fine
  // (a store doing 50/day still fits comfortably under 200 in a 24h window).
  const since = new Date(Date.now() - daysBack * 86_400_000).toISOString()
  const url = new URL(`${base}/sell/fulfillment/v1/order`)
  url.searchParams.set('limit', '200')
  url.searchParams.set('filter', `creationdate:[${since}..]`)

  const startedAt = Date.now()
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Language': 'en-US' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    recordApiCall({
      provider: 'ebay',
      callName: 'GetOrders',
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: `HTTP_${res.status}`,
    }).catch(() => {})
    return []
  }
  recordApiCall({
    provider: 'ebay',
    callName: 'GetOrders',
    success: true,
    durationMs: Date.now() - startedAt,
  }).catch(() => {})
  const data = await res.json().catch(() => ({} as { orders?: EbayOrder[] }))
  return Array.isArray(data.orders) ? data.orders : []
}

/**
 * Pull sales + cancellations from eBay for ALL users, write back to listed_asins.
 * Returns { ordersProcessed, listingsUpdated, cancelsRecorded, errors }.
 */
export async function pullSaleOutcomes(opts: { userId?: number; daysBack?: number } = {}) {
  await ensureListingOutcomeColumns()

  const daysBack = Math.max(1, Math.min(30, opts.daysBack ?? 7))

  const userRows = opts.userId
    ? await queryRows<{ user_id: string }>`
        SELECT DISTINCT user_id::text AS user_id FROM ebay_credentials
        WHERE user_id = ${opts.userId}
      `.catch(() => [])
    : await queryRows<{ user_id: string }>`
        SELECT DISTINCT user_id::text AS user_id FROM ebay_credentials
      `.catch(() => [])

  let ordersProcessed = 0
  let listingsUpdated = 0
  let cancelsRecorded = 0
  const errors: Array<{ userId: string; error: string }> = []

  for (const row of userRows) {
    const creds = await getValidEbayAccessToken(row.user_id).catch(() => null)
    if (!creds?.accessToken) continue
    const base = creds.sandboxMode ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'

    try {
      const orders = await fetchCompletedOrders(base, creds.accessToken, daysBack)
      for (const order of orders) {
        ordersProcessed++
        const cancelled = order.cancelStatus?.cancelState === 'CANCEL_ACCEPTED'
        for (const lineItem of order.lineItems || []) {
          const legacyItemId = lineItem.legacyItemId ? String(lineItem.legacyItemId) : null
          if (!legacyItemId) continue
          const linePrice = parseFloat(lineItem.lineItemCost?.value || lineItem.total?.value || '0') || 0
          const quantity = Number(lineItem.quantity || 1)

          if (cancelled) {
            await sql`
              UPDATE listed_asins
              SET cancel_count = cancel_count + 1
              WHERE user_id::text = ${row.user_id}
                AND ebay_listing_id = ${legacyItemId}
            `.catch(() => {})
            cancelsRecorded++
            continue
          }

          // Successful sale — write sale_price, sold_at, quantity_sold, realized_profit.
          // realized_profit = sale_price - amazon_cost - (sale_price * ebay_fee_rate)
          // Use RETURNING so we can count rows ACTUALLY updated (previous
          // `if (result)` check was always truthy because neon returns [] on
          // 0-row updates — counter was bogus, real updates may have been 0).
          const result = await sql`
            UPDATE listed_asins
            SET
              sold_at = COALESCE(sold_at, ${order.creationDate || new Date().toISOString()}),
              sale_price = COALESCE(sale_price, ${linePrice || null}),
              quantity_sold = quantity_sold + ${quantity},
              realized_profit = COALESCE(realized_profit,
                CASE
                  WHEN ${linePrice} > 0 AND amazon_price IS NOT NULL THEN
                    ROUND(${linePrice} - amazon_price - (${linePrice} * COALESCE(ebay_fee_rate, 0.13)), 2)
                  ELSE NULL
                END
              )
            WHERE user_id::text = ${row.user_id}
              AND ebay_listing_id = ${legacyItemId}
              AND (sold_at IS NULL OR quantity_sold = 0)
            RETURNING ebay_listing_id
          `.catch(() => null)
          const rowsAffected = Array.isArray(result) ? result.length : 0
          if (rowsAffected > 0) {
            listingsUpdated++
          } else {
            // Mismatch — eBay sale's legacyItemId doesn't match our listed_asins.
            // Most often: user listed manually outside StackPilot OR ID format drift.
            console.warn('[outcome-tracker] sale unmatched', JSON.stringify({
              user_id: row.user_id, legacyItemId, quantity, linePrice,
            }))
          }
        }
      }
    } catch (err) {
      errors.push({ userId: row.user_id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { ordersProcessed, listingsUpdated, cancelsRecorded, errors, usersProcessed: userRows.length }
}

// ────────────────────────────── eBay Trading API: engagement ──────────────────────────────

function buildGetItemXml(authToken: string, itemId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${authToken}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeWatchCount>true</IncludeWatchCount>
</GetItemRequest>`
}

async function callGetItem(itemId: string, authToken: string, appId: string): Promise<{ watchCount: number; hitCount: number } | null> {
  const startedAt = Date.now()
  try {
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
        'X-EBAY-API-APP-NAME': appId,
        'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID || '',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-SITEID': '0',
        'Content-Type': 'text/xml',
      },
      body: buildGetItemXml(authToken, itemId),
      signal: AbortSignal.timeout(10000),
    })
    const text = await res.text()
    const ackMatch = text.match(/<Ack>(.*?)<\/Ack>/)
    const isSuccess = ackMatch?.[1] === 'Success' || ackMatch?.[1] === 'Warning'
    recordApiCall({
      provider: 'ebay',
      callName: 'Other', // GetItem isn't in the QUOTA_RULES list, falls through to Other bucket
      success: isSuccess,
      durationMs: Date.now() - startedAt,
    }).catch(() => {})
    if (!isSuccess) return null

    const watchMatch = text.match(/<WatchCount>(\d+)<\/WatchCount>/)
    const hitMatch = text.match(/<HitCount>(\d+)<\/HitCount>/)
    return {
      watchCount: watchMatch ? Number(watchMatch[1]) : 0,
      hitCount: hitMatch ? Number(hitMatch[1]) : 0,
    }
  } catch (err) {
    recordApiCall({
      provider: 'ebay',
      callName: 'Other',
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    }).catch(() => {})
    return null
  }
}

/**
 * Refresh engagement metrics (watch_count, hit_count) for the N stalest active listings.
 * Each listing = 1 Trading API call, so we cap at `limit` per run (default 30) and
 * skip entirely when eBay quota is in warn/block state.
 */
export async function pullEngagementMetrics(opts: { limit?: number; userId?: number } = {}) {
  await ensureListingOutcomeColumns()

  const limit = Math.max(1, Math.min(100, opts.limit ?? 30))
  const appId = String(process.env.EBAY_APP_ID || '').trim()
  if (!appId) return { checked: 0, updated: 0, skipped: 'no_app_id' as const }

  // Quota gate — engagement polling shares the listing-API hourly bucket.
  const quotaState = await getThrottleState('ebay').catch(() => 'ok' as const)
  if (quotaState !== 'ok') {
    return { checked: 0, updated: 0, skipped: `quota_${quotaState}` as const }
  }

  // Pick stalest engagement entries first. (Separate full queries — the neon sql tag executes
  // immediately and does NOT support nested fragment interpolation.)
  const rows = opts.userId
    ? await queryRows<{ user_id: string; ebay_listing_id: string }>`
        SELECT user_id::text AS user_id, ebay_listing_id
        FROM listed_asins
        WHERE ended_at IS NULL
          AND ebay_listing_id IS NOT NULL
          AND user_id = ${opts.userId}
        ORDER BY engagement_checked_at ASC NULLS FIRST
        LIMIT ${limit}
      `.catch(() => [])
    : await queryRows<{ user_id: string; ebay_listing_id: string }>`
        SELECT user_id::text AS user_id, ebay_listing_id
        FROM listed_asins
        WHERE ended_at IS NULL
          AND ebay_listing_id IS NOT NULL
        ORDER BY engagement_checked_at ASC NULLS FIRST
        LIMIT ${limit}
      `.catch(() => [])

  let updated = 0
  const credCache = new Map<string, string | null>()

  for (const row of rows) {
    if (!credCache.has(row.user_id)) {
      const creds = await getValidEbayAccessToken(row.user_id).catch(() => null)
      credCache.set(row.user_id, creds?.accessToken || null)
    }
    const token = credCache.get(row.user_id)
    if (!token) continue

    const metrics = await callGetItem(row.ebay_listing_id, token, appId)
    if (!metrics) {
      // Still mark as checked so we don't hammer the same broken listing every minute.
      await sql`
        UPDATE listed_asins SET engagement_checked_at = NOW()
        WHERE user_id::text = ${row.user_id} AND ebay_listing_id = ${row.ebay_listing_id}
      `.catch(() => {})
      continue
    }

    await sql`
      UPDATE listed_asins
      SET watch_count = ${metrics.watchCount},
          hit_count = ${metrics.hitCount},
          engagement_checked_at = NOW()
      WHERE user_id::text = ${row.user_id} AND ebay_listing_id = ${row.ebay_listing_id}
    `.catch(() => {})
    updated++
  }

  return { checked: rows.length, updated }
}

// ────────────────────────────── Derived: price reductions ──────────────────────────────

/**
 * Recount price reductions per listing from reprice_agent_log. Cheap, runs as part of the
 * outcome cron. A "reduction" is any reprice where new_ebay_price < old_ebay_price.
 */
export async function recomputeReductionCounts() {
  await ensureListingOutcomeColumns()
  const result = await sql`
    UPDATE listed_asins la
    SET reduction_count = COALESCE(sub.reductions, 0)
    FROM (
      SELECT
        ebay_listing_id,
        COUNT(*) FILTER (WHERE new_ebay_price < old_ebay_price)::int AS reductions
      FROM reprice_agent_log
      WHERE success = TRUE
      GROUP BY ebay_listing_id
    ) sub
    WHERE la.ebay_listing_id = sub.ebay_listing_id
      AND la.reduction_count IS DISTINCT FROM sub.reductions
  `.catch(() => null)
  return { ok: !!result }
}
