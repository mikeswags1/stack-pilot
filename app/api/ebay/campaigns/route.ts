import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { getValidEbayAccessToken } from '@/lib/ebay-auth'
import { queryRows } from '@/lib/db'

const MARKETING_BASE = 'https://api.ebay.com/sell/marketing/v1'
const MARKETPLACE_HEADER = { 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' }

function extractEbayError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text)
    const errors: Array<{ longMessage?: string; message?: string }> = parsed.errors || []
    const msg = errors.map(e => e.longMessage || e.message || '').filter(Boolean).join(' ')
    return msg || parsed.message || `eBay error ${status}`
  } catch {
    return text.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || `eBay error ${status}`
  }
}

async function getCampaignListingCount(campaignId: string, accessToken: string) {
  try {
    const url = new URL(`${MARKETING_BASE}/ad_campaign/${campaignId}/ad`)
    url.searchParams.set('limit', '1')
    url.searchParams.set('offset', '0')
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, ...MARKETPLACE_HEADER },
      signal: AbortSignal.timeout(6000),
    })
    const text = await res.text()
    if (!res.ok) return null
    const data = JSON.parse(text) as { total?: number | string; ads?: unknown[] }
    const total = Number(data.total)
    if (Number.isFinite(total)) return total
    return Array.isArray(data.ads) ? data.ads.length : null
  } catch {
    return null
  }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const credentials = await getValidEbayAccessToken(session.user.id)
  if (!credentials?.accessToken) {
    return apiError('Your eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
  }

  try {
    const res = await fetch(`${MARKETING_BASE}/ad_campaign?limit=50&campaign_type=PROMOTED_LISTINGS_STANDARD`, {
      headers: { Authorization: `Bearer ${credentials.accessToken}`, ...MARKETPLACE_HEADER },
      signal: AbortSignal.timeout(12000),
    })

    const text = await res.text()
    if (!res.ok) {
      console.error('[campaigns GET]', res.status, text.slice(0, 400))
      return apiError(extractEbayError(text, res.status), { status: res.status })
    }

    const data = JSON.parse(text) as { campaigns?: Array<Record<string, unknown>> }
    const campaigns = data.campaigns || []
    const [activeListingRows, campaignCounts] = await Promise.all([
      queryRows<{ count: string | number }>`
        SELECT COUNT(*)::int AS count
        FROM listed_asins
        WHERE user_id = ${session.user.id}
          AND ended_at IS NULL
          AND ebay_listing_id IS NOT NULL
          AND ebay_listing_id <> ''
      `.catch(() => []),
      Promise.all(
        campaigns.map(async (campaign) => ({
          campaignId: String(campaign.campaignId || ''),
          listingCount: campaign.campaignId
            ? await getCampaignListingCount(String(campaign.campaignId), credentials.accessToken)
            : null,
        }))
      ),
    ])
    const countByCampaign = new Map(campaignCounts.map((item) => [item.campaignId, item.listingCount]))
    const activeListingCount = Number(activeListingRows[0]?.count || 0)

    return apiOk({
      activeListingCount,
      campaigns: campaigns.map((campaign) => ({
        ...campaign,
        listingCount: countByCampaign.get(String(campaign.campaignId || '')) ?? null,
        activeListingCount,
      })),
    })
  } catch (e) {
    console.error('[campaigns GET] error:', e)
    return apiError('Failed to load campaigns.', { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })

  const body = await req.json().catch(() => ({})) as { name?: string; adRate?: string | number }
  const { name, adRate } = body

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return apiError('Campaign name must be at least 2 characters.', { status: 400 })
  }
  const rate = parseFloat(String(adRate || ''))
  if (!Number.isFinite(rate) || rate < 1 || rate > 20) {
    return apiError('Ad rate must be between 1% and 20%.', { status: 400 })
  }

  const credentials = await getValidEbayAccessToken(session.user.id)
  if (!credentials?.accessToken) {
    return apiError('Your eBay session expired. Reconnect in Settings.', { status: 401, code: 'RECONNECT_REQUIRED' })
  }

  const startDate = new Date().toISOString()

  const requestBody = {
    campaignName: name.trim(),
    // marketplaceId is REQUIRED in the body for ad_campaign creation — the
    // X-EBAY-C-MARKETPLACE-ID header alone is not sufficient for this endpoint.
    marketplaceId: 'EBAY_US',
    campaignType: 'PROMOTED_LISTINGS_STANDARD',
    fundingStrategy: {
      bidPercentage: rate.toFixed(1),
      fundingModel: 'COST_PER_SALE',
    },
    budgetType: 'UNLIMITED',
    startDate,
  }

  console.info('[campaigns POST] creating campaign:', JSON.stringify(requestBody))

  try {
    const res = await fetch(`${MARKETING_BASE}/ad_campaign`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        ...MARKETPLACE_HEADER,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15000),
    })

    const text = await res.text()
    console.info('[campaigns POST] eBay response:', res.status, text.slice(0, 600))

    if (!res.ok) {
      return apiError(extractEbayError(text, res.status), { status: res.status })
    }

    // eBay may return 200 with body, 201 with body, or 204 with campaignId in Location header
    let campaignId: string | undefined
    if (text.trim()) {
      try {
        const data = JSON.parse(text) as { campaignId?: string }
        campaignId = data.campaignId
      } catch { /* not JSON — try Location header */ }
    }
    if (!campaignId) {
      const location = res.headers.get('Location') || ''
      campaignId = location.split('/').pop() || undefined
    }

    return apiOk({ campaignId, message: `Campaign "${name.trim()}" created successfully.` })
  } catch (e) {
    console.error('[campaigns POST] error:', e)
    return apiError('Failed to create campaign. Check your eBay connection.', { status: 500 })
  }
}
