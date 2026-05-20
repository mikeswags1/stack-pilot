import { queryRows, sql } from '@/lib/db'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { createFulfillmentJob, normalizeShipTo } from '@/lib/fulfillment'

type EbayOrderLineItem = {
  lineItemId?: string
  legacyItemId?: string
  title?: string
  quantity?: number
}

type EbayAddress = {
  fullName?: string
  contactAddress?: {
    addressLine1?: string
    addressLine2?: string
    city?: string
    stateOrProvince?: string
    postalCode?: string
    countryCode?: string
  }
  primaryPhone?: { phoneNumber?: string }
}

type EbayOrder = {
  orderId: string
  orderFulfillmentStatus?: string
  cancelStatus?: { cancelState?: string }
  fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: EbayAddress } }>
  lineItems?: EbayOrderLineItem[]
}

type AsinRow = {
  asin: string
}

async function ensureTrackerTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS fulfillment_agent_tracker (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      legacy_item_id TEXT,
      asin TEXT,
      staged BOOLEAN NOT NULL DEFAULT FALSE,
      skip_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS fulfillment_tracker_unique_idx ON fulfillment_agent_tracker (user_id, order_id, COALESCE(legacy_item_id, ''))`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS fulfillment_tracker_user_idx ON fulfillment_agent_tracker (user_id, created_at DESC)`.catch(() => {})
}

async function isAlreadyTracked(userId: string, orderId: string, legacyItemId: string | null): Promise<boolean> {
  const rows = await queryRows<{ id: string | number }>`
    SELECT id FROM fulfillment_agent_tracker
    WHERE user_id = ${userId}
      AND order_id = ${orderId}
      AND COALESCE(legacy_item_id, '') = COALESCE(${legacyItemId}, '')
    LIMIT 1
  `.catch(() => [])
  return rows.length > 0
}

async function isAlreadyFulfillmentJobbed(userId: string, orderId: string): Promise<boolean> {
  const rows = await queryRows<{ id: string | number }>`
    SELECT id FROM fulfillment_jobs
    WHERE user_id = ${userId}
      AND order_id = ${orderId}
    LIMIT 1
  `.catch(() => [])
  return rows.length > 0
}

async function lookupAsinByListingId(userId: string, legacyItemId: string): Promise<string | null> {
  const rows = await queryRows<AsinRow>`
    SELECT asin FROM listed_asins
    WHERE user_id = ${userId}
      AND ebay_listing_id = ${legacyItemId}
      AND asin IS NOT NULL
    LIMIT 1
  `.catch(() => [])
  return rows[0]?.asin || null
}

async function fetchPendingOrders(
  base: string,
  accessToken: string
): Promise<EbayOrder[]> {
  const url = new URL(`${base}/sell/fulfillment/v1/order`)
  url.searchParams.set('limit', '50')
  url.searchParams.set('filter', 'orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}')

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Language': 'en-US' },
    signal: AbortSignal.timeout(12000),
  })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data.orders) ? data.orders : []
}

async function processUserOrders(
  userId: string,
  accessToken: string,
  sandboxMode: boolean,
  options: { dryRun?: boolean }
): Promise<{ staged: number; skipped: number; failed: number }> {
  const base = sandboxMode ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
  const orders = await fetchPendingOrders(base, accessToken).catch(() => [] as EbayOrder[])

  let staged = 0, skipped = 0, failed = 0

  for (const order of orders) {
    if (order.cancelStatus?.cancelState === 'CANCEL_ACCEPTED') { skipped++; continue }

    const alreadyJobbed = await isAlreadyFulfillmentJobbed(userId, order.orderId)
    if (alreadyJobbed) { skipped++; continue }

    const shipToRaw = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo
    const shipTo = normalizeShipTo(shipToRaw)

    for (const lineItem of order.lineItems || []) {
      const legacyItemId = lineItem.legacyItemId ? String(lineItem.legacyItemId) : null
      if (!legacyItemId) { skipped++; continue }

      const tracked = await isAlreadyTracked(userId, order.orderId, legacyItemId)
      if (tracked) { skipped++; continue }

      const asin = await lookupAsinByListingId(userId, legacyItemId)

      if (!asin) {
        await sql`
          INSERT INTO fulfillment_agent_tracker
            (user_id, order_id, legacy_item_id, asin, staged, skip_reason)
          VALUES
            (${userId}, ${order.orderId}, ${legacyItemId}, NULL, FALSE, 'asin_not_found')
        `.catch(() => {})
        skipped++
        continue
      }

      const amazonUrl = `https://www.amazon.com/dp/${asin}`

      if (options.dryRun) {
        staged++
        continue
      }

      try {
        await createFulfillmentJob({
          userId,
          orderId: order.orderId,
          legacyItemId,
          asin,
          amazonUrl,
          shipTo,
          ttlMinutes: 120,
        })
        await sql`
          INSERT INTO fulfillment_agent_tracker
            (user_id, order_id, legacy_item_id, asin, staged, skip_reason)
          VALUES
            (${userId}, ${order.orderId}, ${legacyItemId}, ${asin}, TRUE, NULL)
        `.catch(() => {})
        staged++
      } catch {
        failed++
      }
    }
  }

  return { staged, skipped, failed }
}

export async function runFulfillmentAgent(options: { dryRun?: boolean; userId?: string } = {}) {
  const startedAt = Date.now()
  await ensureTrackerTable()

  const userRows = options.userId
    ? await queryRows<{ user_id: string }>`
        SELECT DISTINCT user_id::text AS user_id
        FROM ebay_credentials
        WHERE user_id::text = ${options.userId}
      `.catch(() => [])
    : await queryRows<{ user_id: string }>`
        SELECT DISTINCT user_id::text AS user_id
        FROM ebay_credentials
      `.catch(() => [])

  let totalStaged = 0, totalSkipped = 0, totalFailed = 0
  const results: Array<{ userId: string; staged: number; skipped: number; failed: number }> = []

  for (const row of userRows) {
    if (Date.now() - startedAt > 240_000) break
    const creds = await getValidEbayAccessToken(row.user_id).catch(() => null)
    if (!creds?.accessToken) { totalSkipped++; continue }

    const result = await processUserOrders(
      row.user_id,
      creds.accessToken,
      creds.sandboxMode || false,
      options
    ).catch(() => ({ staged: 0, skipped: 0, failed: 1 }))

    totalStaged += result.staged
    totalSkipped += result.skipped
    totalFailed += result.failed
    results.push({ userId: row.user_id, ...result })
  }

  return {
    usersProcessed: results.length,
    staged: totalStaged,
    skipped: totalSkipped,
    failed: totalFailed,
    results,
    durationMs: Date.now() - startedAt,
    dryRun: options.dryRun || false,
  }
}
