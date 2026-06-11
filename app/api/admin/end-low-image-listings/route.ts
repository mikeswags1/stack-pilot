import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows } from '@/lib/db'
import { EbayReconnectRequiredError, getValidEbayAccessToken } from '@/lib/ebay-auth'

export const maxDuration = 300

// SECURITY (2026-06-11): this route reads and ENDS listings across ALL users.
// It previously only required any logged-in session — with self-serve signup open,
// any new account could have ended every user's listings. Admin-only, like the
// other /api/admin routes.
const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) return null
  return session
}

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function endItem(
  itemId: string,
  accessToken: string,
  appId: string,
): Promise<{ ok: boolean; error?: string }> {
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
    if (/<Ack>Success<\/Ack>/i.test(text) || /<Ack>Warning<\/Ack>/i.test(text)) return { ok: true }
    const msg = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || 'Unknown eBay error'
    return { ok: false, error: msg }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Request timed out' }
  }
}

type ListingRow = {
  id: number
  user_id: number
  ebay_listing_id: string
  asin: string
  title: string
  image_count: number | null
}

/** GET — preview how many 1-image active listings exist (no changes made) */
export async function GET() {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const rows = await queryRows<ListingRow>`
    SELECT id, user_id, ebay_listing_id, asin, title, image_count
    FROM listed_asins
    WHERE image_count = 1
      AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL
      AND ebay_listing_id <> ''
    ORDER BY listed_at DESC
  `

  return apiOk({
    count: rows.length,
    listings: rows.slice(0, 20).map((r) => ({
      ebayListingId: r.ebay_listing_id,
      asin: r.asin,
      title: r.title,
      imageCount: r.image_count,
    })),
    message: rows.length === 0
      ? 'No active 1-image listings found.'
      : `${rows.length} active listing${rows.length !== 1 ? 's' : ''} with only 1 image. POST with { confirmed: true } to end them on eBay.`,
  })
}

/** POST — end all active 1-image listings on eBay (requires { confirmed: true }) */
export async function POST(req: NextRequest) {
  const session = await requireAdmin()
  if (!session) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const body = await req.json().catch(() => ({}))
  if (!body?.confirmed) {
    return apiError(
      'Pass { confirmed: true } to confirm you want to end all 1-image active listings on eBay.',
      { status: 400, code: 'NOT_CONFIRMED' },
    )
  }

  // Fetch all users' 1-image listings (admin sees all)
  const rows = await queryRows<ListingRow>`
    SELECT id, user_id, ebay_listing_id, asin, title, image_count
    FROM listed_asins
    WHERE image_count = 1
      AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL
      AND ebay_listing_id <> ''
    ORDER BY user_id, listed_at DESC
  `

  if (rows.length === 0) {
    return apiOk({ ended: 0, failed: 0, total: 0, message: 'No 1-image active listings found — nothing to end.' })
  }

  // Group by user so we only fetch one token per user
  const byUser = new Map<number, ListingRow[]>()
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? []
    list.push(row)
    byUser.set(row.user_id, list)
  }

  const appId = process.env.EBAY_APP_ID || ''
  let totalEnded = 0
  let totalFailed = 0
  const endedIds: number[] = []

  for (const [userId, userRows] of byUser.entries()) {
    let credentials: { accessToken: string } | null = null
    try {
      credentials = await getValidEbayAccessToken(String(userId))
    } catch {
      totalFailed += userRows.length
      continue
    }

    if (!credentials?.accessToken) {
      totalFailed += userRows.length
      continue
    }

    const BATCH = 5
    for (let i = 0; i < userRows.length; i += BATCH) {
      const batch = userRows.slice(i, i + BATCH)
      const results = await Promise.allSettled(
        batch.map((r) => endItem(r.ebay_listing_id, credentials!.accessToken, appId)),
      )
      for (let j = 0; j < results.length; j++) {
        const outcome = results[j]
        const row = batch[j]
        if (outcome.status === 'fulfilled' && outcome.value.ok) {
          totalEnded++
          if (row) endedIds.push(row.id)
        } else {
          totalFailed++
        }
      }
    }
  }

  // Mark successfully-ended rows as ended in DB
  if (endedIds.length > 0) {
    // Use individual updates — queryRows doesn't support IN arrays natively
    await Promise.allSettled(
      endedIds.map((id) =>
        queryRows`UPDATE listed_asins SET ended_at = NOW() WHERE id = ${id}`,
      ),
    )
  }

  return apiOk({
    ended: totalEnded,
    failed: totalFailed,
    total: rows.length,
    message: `${totalEnded} 1-image listing${totalEnded !== 1 ? 's' : ''} ended on eBay.${totalFailed > 0 ? ` ${totalFailed} failed (eBay token issue or API error).` : ''}`,
  })
}
