import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { EbayReconnectRequiredError, getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows, sql } from '@/lib/db'
import { retitleForBrand } from '@/lib/brand-strip'

export const maxDuration = 300

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

type Candidate = { ebayListingId: string; oldTitle: string; newTitle: string }

// Live listings whose stored (Amazon) title leads with an obscure brand we can safely
// strip. Returns the cleaned, brand-free, <=80-char eBay title for each.
async function retitleCandidates(userId: string | number): Promise<Candidate[]> {
  const rows = await queryRows<{ ebay_listing_id: string; title: string | null }>`
    SELECT ebay_listing_id, title
    FROM listed_asins
    WHERE user_id = ${userId}
      AND ended_at IS NULL
      AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''
      AND title IS NOT NULL AND title <> ''
  `.catch(() => [])

  const out: Candidate[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.ebay_listing_id)) continue
    const { title: newTitle, brandStripped } = retitleForBrand(r.title || '')
    // Only revise when a brand was actually removed and a solid title remains.
    if (!brandStripped) continue
    if (newTitle.length < 15 || newTitle.split(/\s+/).length < 2) continue
    seen.add(r.ebay_listing_id)
    out.push({ ebayListingId: r.ebay_listing_id, oldTitle: r.title || '', newTitle })
  }
  return out
}

async function reviseTitle(itemId: string, newTitle: string, accessToken: string, appId: string): Promise<{ ok: boolean; permanent: boolean }> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken></RequesterCredentials>
  <Item>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <Title>${escapeXml(newTitle)}</Title>
  </Item>
</ReviseFixedPriceItemRequest>`
  try {
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    if (/<Ack>Success<\/Ack>/i.test(text) || /<Ack>Warning<\/Ack>/i.test(text)) return { ok: true, permanent: false }
    // "No change" / identical title — treat as done, not a failure.
    if (/did not change|no change|identical/i.test(text)) return { ok: true, permanent: false }
    // Quota — stop the whole batch so we don't burn the daily allowance failing.
    if (/exceeded usage limit/i.test(text)) return { ok: false, permanent: false }
    // Anything else (can't revise this item, ended, etc.) is permanent for this item.
    return { ok: false, permanent: true }
  } catch {
    return { ok: false, permanent: false }
  }
}

// GET — preview: how many titles would change, with real before/after samples.
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  const candidates = await retitleCandidates(session.user.id)
  const samples = candidates.slice(0, 10).map((c) => ({
    before: c.oldTitle.slice(0, 72),
    after: c.newTitle,
  }))
  return apiOk({
    count: candidates.length,
    samples,
    message: candidates.length > 0
      ? `${candidates.length} live listing${candidates.length !== 1 ? 's' : ''} lead with an obscure brand. Cleaning them puts product keywords first (better eBay search). The brand stays in the Brand filter.`
      : 'No brand-heavy titles found — your live listings are already keyword-first. 🎉',
  })
}

// POST { confirmed: true } — revise titles in batches with a time budget.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const { confirmed } = await req.json().catch(() => ({}))
  if (!confirmed) {
    return apiError('Pass { confirmed: true } to retitle brand-heavy listings.', { status: 400, code: 'NOT_CONFIRMED' })
  }

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    if (!credentials?.accessToken) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    const appId = process.env.EBAY_APP_ID || ''
    const candidates = await retitleCandidates(session.user.id)
    if (candidates.length === 0) {
      return apiOk({ updated: 0, failed: 0, remaining: 0, message: 'No brand-heavy titles found — nothing to clean. 🎉' })
    }

    const startedAt = Date.now()
    let updated = 0
    let failed = 0
    let processed = 0
    let quotaStopped = false

    for (const c of candidates) {
      if (Date.now() - startedAt > 250_000) break
      const result = await reviseTitle(c.ebayListingId, c.newTitle, credentials.accessToken, appId)
      if (!result.ok && !result.permanent) {
        // Transient/quota — stop the batch; the rest stay as remaining for the next run.
        quotaStopped = true
        break
      }
      processed++
      if (result.ok) updated++
      else failed++
      // Store the cleaned title on both success AND permanent failure. On success it keeps
      // the DB in sync with eBay; on permanent failure (item ended / can't be revised) it
      // stops the same dead listing from re-appearing in "remaining" on every future run.
      await sql`
        UPDATE listed_asins SET title = ${c.newTitle}
        WHERE user_id = ${session.user.id} AND ebay_listing_id = ${c.ebayListingId} AND ended_at IS NULL
      `.catch(() => {})
      // Gentle pace so a big run doesn't hammer eBay.
      await new Promise((r) => setTimeout(r, 120))
    }

    const remaining = Math.max(0, candidates.length - processed)
    return apiOk({
      updated,
      failed,
      remaining,
      total: candidates.length,
      quotaStopped,
      message: `Cleaned ${updated} title${updated !== 1 ? 's' : ''}.${
        quotaStopped
          ? ` eBay's daily revise limit was hit — ${remaining} left, run again after midnight Pacific.`
          : remaining > 0
            ? ` ${remaining} left — click again to finish.`
            : ' Your titles are keyword-first now. 🎉'
      }${failed > 0 ? ` (${failed} couldn't be revised — likely ended or restricted.)` : ''}`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError('Failed to retitle listings.', { status: 500, code: 'RETITLE_FAILED' })
  }
}
