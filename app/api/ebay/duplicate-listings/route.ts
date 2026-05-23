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
  id: number
  listingId: string
  asin: string | null
  title: string
  views: number
  watchers: number
  quantitySold: number
  startTime: string | null
  currentPrice: number
}

type DuplicateGroup = {
  key: string
  label: string
  keep: EbayListingSignal
  end: EbayListingSignal[]
}

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

function normalizeDuplicateTitle(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(new|free|shipping|fast|ship|usa|us|with|for|and|the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getDuplicateKey(listing: EbayListingSignal) {
  const asin = String(listing.asin || '').toUpperCase()
  if (/^[A-Z0-9]{10}$/.test(asin)) return `asin:${asin}`
  const normalizedTitle = normalizeDuplicateTitle(listing.title)
  return normalizedTitle.length >= 12 ? `title:${normalizedTitle}` : ''
}

function sortBestFirst(a: EbayListingSignal, b: EbayListingSignal) {
  if (b.quantitySold !== a.quantitySold) return b.quantitySold - a.quantitySold
  if (b.watchers !== a.watchers) return b.watchers - a.watchers
  if (b.views !== a.views) return b.views - a.views
  return new Date(b.startTime || 0).getTime() - new Date(a.startTime || 0).getTime()
}

async function getActiveListingSignals(accessToken: string, appId: string) {
  const listings = new Map<string, Omit<EbayListingSignal, 'id' | 'asin'>>()

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

async function getDuplicateGroups(userId: string | number, accessToken: string, appId: string) {
  const [localRows, liveSignals] = await Promise.all([
    queryRows<LocalListingRow>`
      SELECT id, ebay_listing_id, asin, title, listed_at
      FROM listed_asins
      WHERE user_id = ${userId}
        AND ended_at IS NULL
        AND ebay_listing_id IS NOT NULL
        AND ebay_listing_id <> ''
      ORDER BY listed_at DESC NULLS LAST
      LIMIT 2500
    `.catch(() => []),
    getActiveListingSignals(accessToken, appId),
  ])

  const localByListingId = new Map(localRows.map((row) => [String(row.ebay_listing_id), row]))
  const grouped = new Map<string, EbayListingSignal[]>()

  for (const signal of liveSignals.values()) {
    const row = localByListingId.get(signal.listingId)
    const listing: EbayListingSignal = {
      ...signal,
      id: row?.id || 0,
      asin: row?.asin || null,
      title: row?.title || signal.title,
      startTime: signal.startTime || row?.listed_at || null,
    }
    const key = getDuplicateKey(listing)
    if (!key) continue
    const current = grouped.get(key) || []
    current.push(listing)
    grouped.set(key, current)
  }

  const duplicateGroups: DuplicateGroup[] = []
  for (const [key, listings] of grouped.entries()) {
    if (listings.length < 2) continue
    const sorted = [...listings].sort(sortBestFirst)
    const keep = sorted[0]
    if (!keep) continue
    duplicateGroups.push({
      key,
      label: key.startsWith('asin:') ? key.replace('asin:', 'ASIN ') : keep.title,
      keep,
      end: sorted.slice(1),
    })
  }

  return duplicateGroups.sort((a, b) => b.end.length - a.end.length || sortBestFirst(a.keep, b.keep))
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

function serializeGroups(groups: DuplicateGroup[]) {
  return groups.slice(0, 20).map((group) => ({
    key: group.key,
    label: group.label,
    keep: {
      ebayListingId: group.keep.listingId,
      title: group.keep.title,
      views: group.keep.views,
      watchers: group.keep.watchers,
      quantitySold: group.keep.quantitySold,
    },
    end: group.end.map((listing) => ({
      ebayListingId: listing.listingId,
      title: listing.title,
      views: listing.views,
      watchers: listing.watchers,
      quantitySold: listing.quantitySold,
    })),
  }))
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

    const groups = await getDuplicateGroups(session.user.id, credentials.accessToken, appId)
    const duplicateCount = groups.reduce((sum, group) => sum + group.end.length, 0)
    return apiOk({
      count: duplicateCount,
      groups: serializeGroups(groups),
      message: duplicateCount === 0
        ? 'No duplicate active listings found.'
        : `${duplicateCount} duplicate listing${duplicateCount === 1 ? '' : 's'} found across ${groups.length} group${groups.length === 1 ? '' : 's'}. Confirming keeps the strongest listing in each group and ends the extras.`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError(error instanceof Error ? error.message : 'Failed to preview duplicate listings.', { status: 500, code: 'DUPLICATE_LISTINGS_PREVIEW_FAILED' })
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const body = await req.json().catch(() => ({}))
  if (!body?.confirmed) {
    return apiError('Pass { confirmed: true } to end duplicate listings.', { status: 400, code: 'NOT_CONFIRMED' })
  }

  try {
    const credentials = await getValidEbayAccessToken(session.user.id)
    const appId = process.env.EBAY_APP_ID || ''
    if (!credentials?.accessToken || !appId) {
      return apiError('eBay is not connected. Reconnect eBay in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }

    const groups = await getDuplicateGroups(session.user.id, credentials.accessToken, appId)
    const selected = groups.flatMap((group) => group.end).slice(0, MAX_END_PER_RUN)
    let ended = 0
    let failed = 0
    const endedIds: number[] = []
    const batchSize = 8

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
      totalMatched: groups.reduce((sum, group) => sum + group.end.length, 0),
      attempted: selected.length,
      message: `${ended} duplicate listing${ended === 1 ? '' : 's'} ended on eBay.${failed > 0 ? ` ${failed} failed.` : ''}`,
    })
  } catch (error) {
    if (error instanceof EbayReconnectRequiredError) {
      return apiError('eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
    }
    return apiError(error instanceof Error ? error.message : 'Failed to end duplicate listings.', { status: 500, code: 'DUPLICATE_LISTINGS_END_FAILED' })
  }
}
