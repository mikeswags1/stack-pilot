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

// Listings whose Amazon source is CONFIRMED out of stock — flagged unavailable at least
// twice (confirmed_count >= 2) and seen OOS recently. These can't be fulfilled, so if a
// buyer orders one it forces a cancellation (an eBay defect). Ending them protects account
// standing. The >= 2 gate is the same confidence the background ender uses; requiring two
// separate OOS reads avoids acting on a single bad scrape.
async function oosListings(userId: string | number) {
  return queryRows<{ ebay_listing_id: string; asin: string; title: string | null }>`
    SELECT ebay_listing_id, asin, title
    FROM listed_asins
    WHERE user_id = ${userId}
      AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL
      AND amazon_available IS FALSE
      AND amazon_unavailable_confirmed_count >= 2
      AND amazon_unavailable_last_seen_at > NOW() - INTERVAL '7 days'
    ORDER BY amazon_unavailable_confirmed_count DESC
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

// GET — preview: how many, plus a few real sample titles so the user can verify it's right.
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  const rows = await oosListings(session.user.id)
  const samples = rows.slice(0, 6).map((r) => String(r.title || r.asin || '').slice(0, 70))
  return apiOk({
    count: rows.length,
    samples,
    message: rows.length > 0
      ? `${rows.length} listing${rows.length !== 1 ? 's' : ''} are confirmed out of stock on Amazon (can't be fulfilled).`
      : 'No confirmed out-of-stock listings — nothing to clean up. 🎉',
  })
}

// POST { confirmed: true } — end the confirmed-OOS listings in batches with a time budget.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const { confirmed } = await req.json().catch(() => ({}))
  if (!confirmed) {
    return apiError('Pass { confirmed: true } to end out-of-stock listings.', { status: 400, code: 'NOT_CONFIRMED' })
  }

  // ── SAFETY PAUSE (2026-06-29) ────────────────────────────────────────────────
  // The Amazon availability data was found UNRELIABLE: listings flagged out-of-stock
  // 9-12 times were spot-checked on Amazon and confirmed IN STOCK. The scraper is
  // hitting bot-detection and misreading available items as "unavailable". Auto-ending
  // on this data would delete good, in-stock listings, so the destructive action is
  // disabled. The GET preview still works. Re-enable only after the availability source
  // is trustworthy (or after adding an independent live re-verify per item).
  if (process.env.OOS_END_ENABLED !== 'true') {
    return apiOk({
      cleared: 0,
      failed: 0,
      remaining: 0,
      paused: true,
      message: 'Paused for safety — the out-of-stock data was found unreliable (it flagged in-stock items as out of stock). Nothing was ended. Re-enables once the Amazon availability source is trustworthy.',
    })
  }

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    if (!credentials?.accessToken) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    const appId = process.env.EBAY_APP_ID || ''
    const ids = [...new Set((await oosListings(session.user.id)).map((r) => r.ebay_listing_id).filter(Boolean))]
    if (ids.length === 0) {
      return apiOk({ cleared: 0, failed: 0, remaining: 0, message: 'No confirmed out-of-stock listings — nothing to clean up. 🎉' })
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
        UPDATE listed_asins SET ended_at = NOW(), amazon_status_reason = 'unavailable_ended'
        WHERE user_id = ${session.user.id} AND ebay_listing_id = ANY(${clearedIds}::text[]) AND ended_at IS NULL
      `.catch(() => {})
    }

    const remaining = Math.max(0, ids.length - processed)
    return apiOk({
      cleared,
      failed,
      remaining,
      total: ids.length,
      message: `Ended ${cleared} out-of-stock listing${cleared !== 1 ? 's' : ''}.${
        remaining > 0 ? ` ${remaining} left — click again to finish.` : ' Your unfulfillable listings are cleared. 🎉'
      }${failed > 0 ? ` (${failed} couldn't be ended — retry or check eBay.)` : ''}`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError('Failed to end out-of-stock listings.', { status: 500, code: 'END_OOS_FAILED' })
  }
}
