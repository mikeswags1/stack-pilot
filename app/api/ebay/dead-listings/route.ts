import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { EbayReconnectRequiredError, getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows, sql } from '@/lib/db'

export const maxDuration = 300

type LocalListingRow = {
  id: number
  ebay_listing_id: string
  asin: string | null
  title: string | null
  listed_at: string | null
}

type EbayListingSignal = {
  listingId: string
  title: string
  views: number
  watchers: number
  quantitySold: number
  startTime: string | null
  currentPrice: number
}

type DeadListingCandidate = LocalListingRow & EbayListingSignal & {
  ageDays: number
  reason: string
}

const MIN_AGE_DAYS = 14
const MAX_VIEWS = 10
const MAX_END_PER_RUN = 2000

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function tag(block: string, name: string) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match?.[1] ? decodeXml(match[1].trim()) : ''
}

function parseMoney(value: string) {
  const parsed = Number.parseFloat(String(value || '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function getAgeDays(value: string | null) {
  if (!value) return 0
  const started = new Date(value).getTime()
  if (!Number.isFinite(started)) return 0
  return Math.max(0, Math.floor((Date.now() - started) / (24 * 60 * 60 * 1000)))
}

async function getActiveListingSignals(accessToken: string, appId: string) {
  const listings = new Map<string, EbayListingSignal>()

  const fetchPage = async (page: number) => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeWatchCount>true</IncludeWatchCount>
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`

    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': appId,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    if (!res.ok || /<Ack>Failure<\/Ack>/i.test(text)) {
      throw new Error(tag(text, 'LongMessage') || `eBay active listing request failed (${res.status}).`)
    }

    return [...text.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map((match) => String(match[1] || ''))
  }

  for (let page = 1; page <= 10; page += 1) {
    const blocks = await fetchPage(page)
    for (const block of blocks) {
      const listingId = tag(block, 'ItemID')
      if (!listingId) continue
      listings.set(listingId, {
        listingId,
        title: tag(block, 'Title'),
        views: Number(tag(block, 'HitCount')) || 0,
        watchers: Number(tag(block, 'WatchCount')) || 0,
        quantitySold: Number(tag(block, 'QuantitySold')) || 0,
        startTime: tag(block, 'StartTime') || null,
        currentPrice: parseMoney(tag(block, 'CurrentPrice') || tag(block, 'StartPrice')),
      })
    }
    if (blocks.length < 200) break
  }

  return listings
}

async function getDeadListingCandidates(userId: string | number, accessToken: string, appId: string) {
  const [localRows, liveSignals] = await Promise.all([
    queryRows<LocalListingRow>`
      SELECT id, ebay_listing_id, asin, title, listed_at
      FROM listed_asins
      WHERE user_id = ${userId}
        AND ended_at IS NULL
        AND ebay_listing_id IS NOT NULL
        AND ebay_listing_id <> ''
      ORDER BY listed_at ASC NULLS FIRST
      LIMIT 2500
    `.catch(() => []),
    getActiveListingSignals(accessToken, appId),
  ])

  const localByListingId = new Map(localRows.map((row) => [String(row.ebay_listing_id), row]))
  const candidates: DeadListingCandidate[] = []

  for (const signal of liveSignals.values()) {
    const row = localByListingId.get(signal.listingId)
    const ageDays = Math.max(getAgeDays(signal.startTime), getAgeDays(row?.listed_at || null))
    const noSales = signal.quantitySold === 0
    const noInterest = signal.watchers === 0 && signal.views <= MAX_VIEWS
    if (ageDays >= MIN_AGE_DAYS && noSales && noInterest) {
      candidates.push({
        ...signal,
        id: row?.id || 0,
        ebay_listing_id: signal.listingId,
        asin: row?.asin || null,
        listed_at: row?.listed_at || signal.startTime,
        title: row?.title || signal.title,
        ageDays,
        reason: `${ageDays} days old, ${signal.views} view${signal.views === 1 ? '' : 's'}, 0 watchers, 0 sold`,
      })
    }
  }

  return candidates.sort((a, b) => a.views - b.views || b.ageDays - a.ageDays)
}

async function endItem(itemId: string, accessToken: string, appId: string) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(accessToken)}</eBayAuthToken></RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <EndingReason>NotAvailable</EndingReason>
</EndItemRequest>`

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
  }).catch(() => null)

  if (!res) return { ok: false, error: 'eBay request timed out.' }
  const text = await res.text()
  if (/<Ack>Success<\/Ack>/i.test(text) || /<Ack>Warning<\/Ack>/i.test(text)) return { ok: true }
  return { ok: false, error: tag(text, 'LongMessage') || 'Unknown eBay error.' }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    const appId = process.env.EBAY_APP_ID || ''
    if (!credentials?.accessToken || !appId) {
      return apiError('eBay is not connected. Reconnect eBay in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }

    const candidates = await getDeadListingCandidates(session.user.id, credentials.accessToken, appId)
    return apiOk({
      count: candidates.length,
      criteria: { minAgeDays: MIN_AGE_DAYS, maxViews: MAX_VIEWS, watchers: 0, sold: 0 },
      listings: candidates.slice(0, 30).map((listing) => ({
        ebayListingId: listing.listingId,
        asin: listing.asin,
        title: listing.title,
        views: listing.views,
        watchers: listing.watchers,
        quantitySold: listing.quantitySold,
        ageDays: listing.ageDays,
        price: listing.currentPrice,
        reason: listing.reason,
      })),
      message: candidates.length === 0
        ? 'No poor-performing listings found with the current cleanup rule.'
        : `${candidates.length} poor-performing listing${candidates.length === 1 ? '' : 's'} found: 14+ days old, 0 sold, 0 watchers, and 10 or fewer views. Confirming will end all matched listings.`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError(error instanceof Error ? error.message : 'Failed to preview dead listings.', { status: 500, code: 'DEAD_LISTINGS_PREVIEW_FAILED' })
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const body = await req.json().catch(() => ({}))
  if (!body?.confirmed) {
    return apiError('Pass { confirmed: true } to end dead listings.', { status: 400, code: 'NOT_CONFIRMED' })
  }

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    const appId = process.env.EBAY_APP_ID || ''
    if (!credentials?.accessToken || !appId) {
      return apiError('eBay is not connected. Reconnect eBay in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }

    const candidates = await getDeadListingCandidates(session.user.id, credentials.accessToken, appId)
    const selected = candidates.slice(0, MAX_END_PER_RUN)
    let ended = 0
    let failed = 0
    const endedIds: number[] = []
    const batchSize = 12

    for (let index = 0; index < selected.length; index += batchSize) {
      const batch = selected.slice(index, index + batchSize)
      const results = await Promise.allSettled(
        batch.map((listing) => endItem(listing.listingId, credentials.accessToken, appId)),
      )
      for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
        const result = results[resultIndex]
        const listing = batch[resultIndex]
        if (result?.status === 'fulfilled' && result.value.ok && listing) {
          ended += 1
          if (listing.id > 0) endedIds.push(listing.id)
        } else {
          failed += 1
        }
      }
    }

    if (endedIds.length > 0) {
      await sql`
        UPDATE listed_asins
        SET ended_at = NOW()
        WHERE user_id = ${session.user.id}
          AND id = ANY(${endedIds}::int[])
      `.catch(() => {})
    }

    return apiOk({
      ended,
      failed,
      totalMatched: candidates.length,
      attempted: selected.length,
      remaining: Math.max(0, candidates.length - selected.length),
      message: `${ended} dead listing${ended === 1 ? '' : 's'} ended on eBay.${failed > 0 ? ` ${failed} failed.` : ''}${candidates.length > selected.length ? ` ${candidates.length - selected.length} remain for another cleanup run.` : ''}`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError(error instanceof Error ? error.message : 'Failed to end dead listings.', { status: 500, code: 'DEAD_LISTINGS_END_FAILED' })
  }
}
