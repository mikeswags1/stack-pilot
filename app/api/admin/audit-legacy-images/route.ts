/**
 * GET  /api/admin/audit-legacy-images
 *   Finds active listings where image_count IS NULL (created before the
 *   image-quality system was deployed).  For each one it calls eBay's
 *   GetItem API to fetch the live picture count, then:
 *     - writes image_count back into listed_asins (so the row is no
 *       longer "legacy" after the first audit)
 *     - classifies the listing: 1-image | 2-images | 3+-images | unverified
 *   Returns the full classified list.  Nothing is ended.
 *
 * POST /api/admin/audit-legacy-images
 *   Body: { confirmed: true, ids: number[] }
 *   Ends the specified listed_asins row IDs on eBay and marks them ended
 *   in the DB.  The caller is responsible for showing a preview first.
 */
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows, sql } from '@/lib/db'

// SECURITY (2026-06-11): this route reads + ENDS listings across ALL users.
// Admin-only, matching the rest of /api/admin.
const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']
import { EbayReconnectRequiredError, getValidEbayAccessToken } from '@/lib/ebay-auth'

export const maxDuration = 300

// Max listings to inspect in one audit run — keeps the request under Vercel's
// timeout ceiling even if a user has hundreds of old listings.
const AUDIT_CAP = 200
const BATCH_SIZE = 4        // concurrent GetItem calls per batch
const BATCH_DELAY_MS = 250  // ms between batches — avoids eBay rate limits

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Returns the picture count for a live eBay listing, or null if the call fails. */
async function getLiveImageCount(
  itemId: string,
  accessToken: string,
  appId: string,
): Promise<number | null> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
</GetItemRequest>`

  try {
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(10000),
    })
    const text = await res.text()

    // Ended or invalid listings come back with a Failure ack
    if (!/<Ack>Success<\/Ack>/i.test(text) && !/<Ack>Warning<\/Ack>/i.test(text)) {
      return null
    }

    // Count <PictureURL> elements — each one is a distinct listing image
    const matches = text.match(/<PictureURL>/gi)
    return matches ? matches.length : 0
  } catch {
    return null
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ListingRow = {
  id: number
  user_id: number
  ebay_listing_id: string
  asin: string
  title: string
  listed_at: string | null
}

export type AuditedListing = {
  id: number
  userId: number
  ebayListingId: string
  asin: string
  title: string
  listedAt: string | null
  liveImageCount: number | null
  classification: '1-image' | '2-images' | '3+-images' | 'unverified'
  suggestedAction: string
  ebayLink: string
}

function classify(count: number | null): AuditedListing['classification'] {
  if (count === null) return 'unverified'
  if (count <= 1) return '1-image'
  if (count === 2) return '2-images'
  return '3+-images'
}

function suggestAction(classification: AuditedListing['classification']): string {
  switch (classification) {
    case '1-image':   return 'End and relist — 1 image hurts buyer trust and conversion'
    case '2-images':  return 'Acceptable, but monitor — consider ending if sales are slow'
    case '3+-images': return 'Good — keep active'
    case 'unverified': return 'Could not reach eBay — check manually'
  }
}

/** GET — dry-run audit of all legacy (NULL image_count) active listings */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  const rows = await queryRows<ListingRow>`
    SELECT id, user_id, ebay_listing_id, asin, title, listed_at
    FROM listed_asins
    WHERE image_count IS NULL
      AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL
      AND ebay_listing_id <> ''
    ORDER BY listed_at DESC
    LIMIT ${AUDIT_CAP}
  `

  if (rows.length === 0) {
    return apiOk({
      total: 0,
      capped: false,
      listings: [],
      summary: { oneImage: 0, twoImages: 0, threePlus: 0, unverified: 0 },
      message: 'No legacy listings found — all active listings already have image_count recorded.',
    })
  }

  const appId = process.env.EBAY_APP_ID || ''

  // Group rows by user so we only get one token per user
  const byUser = new Map<number, ListingRow[]>()
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? []
    list.push(row)
    byUser.set(row.user_id, list)
  }

  const audited: AuditedListing[] = []

  for (const [userId, userRows] of byUser.entries()) {
    let credentials: { accessToken: string } | null = null
    try {
      credentials = await getValidEbayAccessToken(String(userId))
    } catch {
      // Can't verify this user's listings — mark all unverified
      for (const row of userRows) {
        audited.push({
          id: row.id,
          userId: row.user_id,
          ebayListingId: row.ebay_listing_id,
          asin: row.asin,
          title: row.title,
          listedAt: row.listed_at,
          liveImageCount: null,
          classification: 'unverified',
          suggestedAction: suggestAction('unverified'),
          ebayLink: `https://www.ebay.com/itm/${row.ebay_listing_id}`,
        })
      }
      continue
    }

    if (!credentials?.accessToken) {
      for (const row of userRows) {
        audited.push({
          id: row.id,
          userId: row.user_id,
          ebayListingId: row.ebay_listing_id,
          asin: row.asin,
          title: row.title,
          listedAt: row.listed_at,
          liveImageCount: null,
          classification: 'unverified',
          suggestedAction: suggestAction('unverified'),
          ebayLink: `https://www.ebay.com/itm/${row.ebay_listing_id}`,
        })
      }
      continue
    }

    // Fetch in small concurrent batches to stay under eBay rate limits
    for (let i = 0; i < userRows.length; i += BATCH_SIZE) {
      if (i > 0) await delay(BATCH_DELAY_MS)

      const batch = userRows.slice(i, i + BATCH_SIZE)
      const counts = await Promise.all(
        batch.map((row) => getLiveImageCount(row.ebay_listing_id, credentials!.accessToken, appId)),
      )

      const updates: Array<{ id: number; count: number }> = []
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j]
        const count = counts[j]
        const classification = classify(count)
        audited.push({
          id: row.id,
          userId: row.user_id,
          ebayListingId: row.ebay_listing_id,
          asin: row.asin,
          title: row.title,
          listedAt: row.listed_at,
          liveImageCount: count,
          classification,
          suggestedAction: suggestAction(classification),
          ebayLink: `https://www.ebay.com/itm/${row.ebay_listing_id}`,
        })

        // Persist the verified count so the row is no longer "legacy" next time
        if (count !== null) {
          updates.push({ id: row.id, count })
        }
      }

      // Write image_count back to DB for verified rows (fire-and-forget batch)
      await Promise.allSettled(
        updates.map(({ id, count }) =>
          sql`UPDATE listed_asins SET image_count = ${count} WHERE id = ${id}`,
        ),
      )
    }
  }

  const summary = {
    oneImage:    audited.filter((l) => l.classification === '1-image').length,
    twoImages:   audited.filter((l) => l.classification === '2-images').length,
    threePlus:   audited.filter((l) => l.classification === '3+-images').length,
    unverified:  audited.filter((l) => l.classification === 'unverified').length,
  }

  const totalRemaining = await queryRows<{ count: string }>`
    SELECT COUNT(*)::text AS count
    FROM listed_asins
    WHERE image_count IS NULL AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''
  `.then((r) => parseInt(r[0]?.count ?? '0', 10)).catch(() => 0)

  return apiOk({
    total: audited.length,
    capped: rows.length === AUDIT_CAP,
    remainingLegacy: totalRemaining,
    listings: audited,
    summary,
    message: `Audited ${audited.length} legacy listing${audited.length !== 1 ? 's' : ''}: ${summary.oneImage} with 1 image, ${summary.twoImages} with 2, ${summary.threePlus} with 3+, ${summary.unverified} unverified.`,
  })
}

/** POST — end a specific set of listings (must pass confirmed + ids) */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  const body = await req.json().catch(() => ({}))
  if (!body?.confirmed) {
    return apiError('Pass { confirmed: true, ids: number[] } to end selected listings.', { status: 400, code: 'NOT_CONFIRMED' })
  }
  const ids: number[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === 'number') : []
  if (ids.length === 0) {
    return apiError('No listing IDs provided.', { status: 400, code: 'NO_IDS' })
  }

  // Load the selected rows — one DB round-trip, avoid IN array syntax issues
  const rows = await queryRows<ListingRow & { ebay_listing_id: string }>`
    SELECT id, user_id, ebay_listing_id, asin, title, listed_at
    FROM listed_asins
    WHERE id = ANY(${ids}::int[])
      AND ended_at IS NULL
  `

  if (rows.length === 0) {
    return apiOk({ ended: 0, failed: 0, message: 'No matching active listings found.' })
  }

  const appId = process.env.EBAY_APP_ID || ''
  const byUser = new Map<number, typeof rows>()
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? []
    list.push(row)
    byUser.set(row.user_id, list)
  }

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

    for (let i = 0; i < userRows.length; i += BATCH_SIZE) {
      if (i > 0) await delay(BATCH_DELAY_MS)
      const batch = userRows.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map((row) => endItemOnEbay(row.ebay_listing_id, credentials!.accessToken, appId)),
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

  if (endedIds.length > 0) {
    await sql`UPDATE listed_asins SET ended_at = NOW() WHERE id = ANY(${endedIds}::int[])`.catch(() => {})
  }

  return apiOk({
    ended: totalEnded,
    failed: totalFailed,
    total: rows.length,
    message: `${totalEnded} listing${totalEnded !== 1 ? 's' : ''} ended on eBay.${totalFailed > 0 ? ` ${totalFailed} could not be ended (eBay API error).` : ''}`,
  })
}

async function endItemOnEbay(
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
