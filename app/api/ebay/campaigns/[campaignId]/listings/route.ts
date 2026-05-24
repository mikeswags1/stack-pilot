import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows } from '@/lib/db'

const MARKETING_BASE = 'https://api.ebay.com/sell/marketing/v1'

// Add all active eBay listings to this campaign
export async function POST(req: NextRequest, context: { params: Promise<{ campaignId: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const { campaignId } = await context.params

  const credentials = await getValidEbayAccessToken(session.user.id)
  if (!credentials?.accessToken) {
    return apiError('Your eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
  }

  // Load all active listing IDs for this user
  const rows = await queryRows<{ ebay_listing_id: string }>`
    SELECT ebay_listing_id
    FROM listed_asins
    WHERE user_id = ${session.user.id}
      AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL
    ORDER BY listed_at DESC
    LIMIT 500
  `.catch(() => [])

  if (rows.length === 0) {
    return apiOk({ added: 0, failed: 0, total: 0, message: 'No active listings found to add to this campaign.' })
  }

  const listingIds = rows.map(r => r.ebay_listing_id)
  let added = 0
  let failed = 0
  const errorSamples: string[] = []  // capture actual eBay error messages

  // Extract the first useful error text from an eBay error response payload
  const extractErrorText = (text: string): string => {
    try {
      const parsed = JSON.parse(text)
      const errors: Array<{ longMessage?: string; message?: string; errorId?: number; parameters?: Array<{ name?: string; value?: string }> }> =
        parsed.errors || []
      const first = errors[0]
      if (first) {
        const params = (first.parameters || []).map(p => `${p.name}=${p.value}`).join(', ')
        return `${first.longMessage || first.message || 'eBay error'}${params ? ` [${params}]` : ''}${first.errorId ? ` (errorId ${first.errorId})` : ''}`
      }
      return parsed.message || text.slice(0, 200)
    } catch {
      return text.slice(0, 200)
    }
  }

  // eBay BulkCreateAdsByListingId: max 500 per call, body = { requests: [{listingId: "..."}] }
  // For PROMOTED_LISTINGS_STANDARD / COST_PER_SALE, bidPercentage is set at campaign level.
  const BATCH_SIZE = 25

  for (let i = 0; i < listingIds.length; i += BATCH_SIZE) {
    const batch = listingIds.slice(i, i + BATCH_SIZE)

    const reqBody = {
      requests: batch.map(id => ({ listingId: id })),
    }

    try {
      const res = await fetch(
        `${MARKETING_BASE}/ad_campaign/${campaignId}/ads/bulk_create_ads_by_listing_id`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            'Content-Type': 'application/json',
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(20000),
        }
      )

      const text = await res.text()
      console.info(`[campaigns/listings] batch ${i}-${i + batch.length}: HTTP ${res.status}`, text.slice(0, 400))

      if (res.ok) {
        try {
          const data = JSON.parse(text) as {
            responses?: Array<{ errors?: Array<{ longMessage?: string; message?: string; errorId?: number }>; listingId?: string; statusCode?: number }>
          }
          const responses = data.responses || []
          const batchAdded = responses.filter(r => !r.errors || r.errors.length === 0).length
          const batchFailedItems = responses.filter(r => r.errors && r.errors.length > 0)
          added += batchAdded || (responses.length === 0 ? batch.length : 0)
          failed += batchFailedItems.length
          // capture per-listing errors so we can show the real reason
          for (const item of batchFailedItems) {
            const e = item.errors?.[0]
            if (!e) continue
            const msg = `${e.longMessage || e.message}${e.errorId ? ` (errorId ${e.errorId})` : ''}`
            if (errorSamples.length < 3 && !errorSamples.includes(msg)) errorSamples.push(msg)
          }
        } catch {
          added += batch.length
        }
      } else {
        // Capture eBay's actual error message
        const errMsg = extractErrorText(text)
        console.error(`[campaigns/listings] HTTP ${res.status}:`, errMsg)
        if (errorSamples.length < 3 && !errorSamples.includes(errMsg)) errorSamples.push(`HTTP ${res.status}: ${errMsg}`)
        failed += batch.length
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error('[campaigns/listings] fetch error:', errMsg)
      if (errorSamples.length < 3) errorSamples.push(`Network error: ${errMsg}`)
      failed += batch.length
    }
  }

  const total = listingIds.length
  const message = added > 0
    ? `${added} of ${total} listing${total !== 1 ? 's' : ''} added.${failed > 0 ? ` ${failed} skipped: ${errorSamples[0] || 'unknown reason'}` : ''}`
    : `Failed to add ${total} listings. eBay says: ${errorSamples.join(' | ') || 'no error text returned'}`

  return apiOk({ added, failed, total, message, errorSamples })
}
