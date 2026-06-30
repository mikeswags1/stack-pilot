import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { EbayReconnectRequiredError, getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows, sql } from '@/lib/db'

export const maxDuration = 300

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Listings that are LIKELY a real loss: the (last-known) Amazon cost is above what the eBay
// price clears after fees, AND the Amazon cost is within ~2x of the eBay price. The <=2x gate
// is the key: a genuine price rise stays within ~2x, while an absurd ratio (eBay $20 / "Amazon
// $150") is a bad scrape, not a real loss — those are excluded so good listings aren't deleted.
async function lossListings(userId: string | number) {
  return queryRows<{ ebay_listing_id: string; title: string | null; ebay_price: number; amazon_cost: number }>`
    SELECT la.ebay_listing_id, la.title,
           la.ebay_price::float AS ebay_price,
           COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price)::float AS amazon_cost
    FROM listed_asins la
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(la.asin)
    WHERE la.user_id = ${userId}
      AND la.ended_at IS NULL
      AND la.ebay_listing_id IS NOT NULL
      AND la.ebay_price > 0
      AND COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price) > 0
      AND la.ebay_price::float * (1 - COALESCE(NULLIF(la.ebay_fee_rate, 0), 0.136)) - 0.4
          - COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price)::float * 1.07 < 0
      AND COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price)::float <= la.ebay_price::float * 2
    ORDER BY (COALESCE(NULLIF(apc.amazon_price, 0), la.amazon_price)::float - la.ebay_price::float) DESC
  `.catch(() => [])
}

async function endItem(itemId: string, accessToken: string, appId: string): Promise<{ ok: boolean; alreadyEnded: boolean }> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndItemRequest>`
  try {
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'EndItem',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(12000),
    })
    const text = await res.text()
    if (/<Ack>Success<\/Ack>/i.test(text) || /<Ack>Warning<\/Ack>/i.test(text)) return { ok: true, alreadyEnded: false }
    const alreadyEnded = /already|ended|closed|not found|invalid item|cannot be ended|no longer/i.test(text)
    return { ok: false, alreadyEnded }
  } catch {
    return { ok: false, alreadyEnded: false }
  }
}

// GET — preview: count + real samples WITH PRICES so the user can verify each is a true loss.
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  const rows = await lossListings(session.user.id)
  const samples = rows.slice(0, 8).map((r) =>
    `eBay $${Number(r.ebay_price).toFixed(2)} < Amazon $${Number(r.amazon_cost).toFixed(2)} — ${String(r.title || '').slice(0, 48)}`
  )
  return apiOk({
    count: rows.length,
    samples,
    message: rows.length > 0
      ? `${rows.length} listing${rows.length !== 1 ? 's' : ''} are likely selling below cost (Amazon price realistically above your eBay price).`
      : 'No likely-loss listings found — nothing to clean up. 🎉',
  })
}

// POST { confirmed: true } — end the likely-loss listings in batches with a time budget.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const { confirmed } = await req.json().catch(() => ({}))
  if (!confirmed) {
    return apiError('Pass { confirmed: true } to end likely-loss listings.', { status: 400, code: 'NOT_CONFIRMED' })
  }

  // ── SAFETY PAUSE (2026-06-30) ────────────────────────────────────────────────
  // The stored Amazon prices this relies on were found UNRELIABLE: the user verified that
  // items flagged here as "loss-makers" actually have LOWER real prices on Amazon (false
  // positives). Auto-ending on them would delete good listings, so the destructive action is
  // disabled — the GET preview still works as a manual REVIEW list (suspects to check on
  // Amazon yourself). Re-enable only when there is a trustworthy live price source.
  if (process.env.LIKELY_LOSS_END_ENABLED !== 'true') {
    return apiOk({
      cleared: 0,
      failed: 0,
      remaining: 0,
      paused: true,
      message: 'Paused for safety — the Amazon prices here were found unreliable (items flagged as losses had LOWER real prices on Amazon). Nothing ended. Use this as a list to spot-check on Amazon yourself.',
    })
  }

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    if (!credentials?.accessToken) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    const appId = process.env.EBAY_APP_ID || ''
    const ids = [...new Set((await lossListings(session.user.id)).map((r) => r.ebay_listing_id).filter(Boolean))]
    if (ids.length === 0) {
      return apiOk({ cleared: 0, failed: 0, remaining: 0, message: 'No likely-loss listings found — nothing to clean up. 🎉' })
    }

    const startedAt = Date.now()
    let cleared = 0
    let failed = 0
    let processed = 0
    const clearedIds: string[] = []
    const BATCH = 5

    for (let i = 0; i < ids.length; i += BATCH) {
      if (Date.now() - startedAt > 250_000) break
      const batch = ids.slice(i, i + BATCH)
      const results = await Promise.allSettled(batch.map((id) => endItem(id, credentials.accessToken, appId)))
      results.forEach((r, idx) => {
        processed++
        if (r.status === 'fulfilled' && (r.value.ok || r.value.alreadyEnded)) {
          cleared++
          clearedIds.push(batch[idx])
        } else {
          failed++
        }
      })
    }

    if (clearedIds.length > 0) {
      await sql`
        UPDATE listed_asins SET ended_at = NOW(), amazon_status_reason = 'ended_below_cost'
        WHERE user_id = ${session.user.id} AND ebay_listing_id = ANY(${clearedIds}::text[]) AND ended_at IS NULL
      `.catch(() => {})
    }

    const remaining = Math.max(0, ids.length - processed)
    return apiOk({
      cleared,
      failed,
      remaining,
      total: ids.length,
      message: `Ended ${cleared} likely-loss listing${cleared !== 1 ? 's' : ''}.${
        remaining > 0 ? ` ${remaining} left — click again to finish.` : ' Your loss-makers are cleared. 🎉'
      }${failed > 0 ? ` (${failed} couldn't be ended — retry or check eBay.)` : ''}`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError('Failed to end likely-loss listings.', { status: 500, code: 'END_LOSS_FAILED' })
  }
}
