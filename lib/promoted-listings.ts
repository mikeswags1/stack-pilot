// Auto-enrollment into Promoted Listings. Every successfully published listing is
// added to the user's running COST_PER_SALE campaign so new inventory gets paid
// search visibility immediately (organic placement is suppressed while the account
// is below standard). Fire-and-forget from the listing flow — never blocks a listing.

import { getValidEbayAccessToken } from '@/lib/ebay-auth'

const MARKETING_BASE = 'https://api.ebay.com/sell/marketing/v1'

type CampaignPick = { campaignId: string; bidPercentage: string }
const campaignCache = new Map<string, { at: number; pick: CampaignPick | null }>()
const CACHE_TTL_MS = 10 * 60 * 1000

async function pickRunningCampaign(userId: number | string, accessToken: string): Promise<CampaignPick | null> {
  const key = String(userId)
  const cached = campaignCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.pick

  let pick: CampaignPick | null = null
  try {
    const res = await fetch(`${MARKETING_BASE}/ad_campaign?limit=50&campaign_type=PROMOTED_LISTINGS_STANDARD`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) {
      const data = (await res.json()) as { campaigns?: Array<{ campaignId?: string; campaignStatus?: string; fundingStrategy?: { fundingModel?: string; bidPercentage?: string } }> }
      const running = (data.campaigns || []).filter(
        (c) => c.campaignStatus === 'RUNNING' && c.fundingStrategy?.fundingModel === 'COST_PER_SALE' && c.campaignId
      )
      const first = running[0]
      if (first?.campaignId) {
        pick = { campaignId: String(first.campaignId), bidPercentage: String(first.fundingStrategy?.bidPercentage || '4.0') }
      }
    }
  } catch { /* no campaign -> no enrollment; listing itself is unaffected */ }
  campaignCache.set(key, { at: Date.now(), pick })
  return pick
}

export async function enrollListingInPromotedCampaign(userId: number | string, listingId: string): Promise<void> {
  try {
    const credentials = await getValidEbayAccessToken(String(userId))
    if (!credentials?.accessToken) return
    const campaign = await pickRunningCampaign(userId, credentials.accessToken)
    if (!campaign) return
    await fetch(`${MARKETING_BASE}/ad_campaign/${campaign.campaignId}/bulk_create_ads_by_listing_id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
      body: JSON.stringify({ requests: [{ listingId, bidPercentage: campaign.bidPercentage }] }),
      signal: AbortSignal.timeout(8000),
    })
  } catch { /* best-effort — a missed enrollment is picked up by the next manual sweep */ }
}
