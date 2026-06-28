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

// Active coin/bullion listings for this user. Matches the same precious-metal signals the
// listing-policy block uses, plus the cut "Coins & Currency" niche. NORMAL products never match.
async function coinListingIds(userId: string | number): Promise<string[]> {
  const rows = await queryRows<{ ebay_listing_id: string }>`
    SELECT ebay_listing_id
    FROM listed_asins
    WHERE user_id = ${userId}
      AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL
      AND (
        niche ILIKE '%coin%' OR niche ILIKE '%currenc%'
        OR title ILIKE '%silver eagle%' OR title ILIKE '%gold eagle%'
        OR title ILIKE '%.999%' OR title ILIKE '%bullion%'
        OR title ILIKE '%troy oz%' OR title ILIKE '%gold buffalo%'
        OR title ILIKE '%krugerrand%' OR title ILIKE '%maple leaf%'
        OR title ILIKE '%numismatic%' OR title ILIKE '%morgan dollar%'
        OR title ILIKE '%peace dollar%' OR title ILIKE '%proof coin%'
      )
  `.catch(() => [])
  return [...new Set(rows.map((r) => r.ebay_listing_id).filter(Boolean))]
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
    // A listing that eBay already closed/can't find is a DB ghost — treat as cleared so the
    // record clears and we don't keep retrying it on the next click.
    const alreadyEnded = /already|ended|closed|not found|invalid item|cannot be ended|no longer/i.test(text)
    return { ok: false, alreadyEnded }
  } catch {
    return { ok: false, alreadyEnded: false }
  }
}

// GET — preview how many coin listings would be ended (no changes made).
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  const ids = await coinListingIds(session.user.id)
  return apiOk({
    count: ids.length,
    message: ids.length > 0
      ? `${ids.length} coin/bullion listing${ids.length !== 1 ? 's' : ''} found. Your normal products are not included.`
      : 'No coin listings found — your store is already clean. 🎉',
  })
}

// POST { confirmed: true } — end the coin listings. Processes in batches with a time budget;
// if there are more than one run can finish, returns `remaining` so the UI can click again.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const { confirmed } = await req.json().catch(() => ({}))
  if (!confirmed) {
    return apiError('Pass { confirmed: true } to end your coin/bullion listings.', { status: 400, code: 'NOT_CONFIRMED' })
  }

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    if (!credentials?.accessToken) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    const appId = process.env.EBAY_APP_ID || ''
    const ids = await coinListingIds(session.user.id)
    if (ids.length === 0) {
      return apiOk({ cleared: 0, failed: 0, remaining: 0, message: 'No coin listings found — your store is already clean. 🎉' })
    }

    const startedAt = Date.now()
    let cleared = 0
    let failed = 0
    let processed = 0
    const clearedIds: string[] = []
    const BATCH = 5

    for (let i = 0; i < ids.length; i += BATCH) {
      // Leave headroom under the 300s function cap; the UI re-clicks to finish the rest.
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
        UPDATE listed_asins SET ended_at = NOW()
        WHERE user_id = ${session.user.id} AND ebay_listing_id = ANY(${clearedIds}::text[]) AND ended_at IS NULL
      `.catch(() => {})
    }

    const remaining = Math.max(0, ids.length - processed)
    return apiOk({
      cleared,
      failed,
      remaining,
      total: ids.length,
      message: `Cleared ${cleared} coin listing${cleared !== 1 ? 's' : ''}.${
        remaining > 0 ? ` ${remaining} left — click again to finish.` : ' Your store is now coin-free. 🎉'
      }${failed > 0 ? ` (${failed} couldn't be ended — retry or check eBay.)` : ''}`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError('Failed to end coin listings.', { status: 500, code: 'END_COINS_FAILED' })
  }
}
