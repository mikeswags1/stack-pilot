// Boss Overview — the clean, single-source-of-truth admin summary.
// Admin-only. Returns exactly what the owner needs to judge the business at a
// glance: accounts, source pool health, sales/money, and whether the automation
// is alive. Every query is independent + fail-soft so one bad table can't blank
// the whole page.
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { apiError, apiOk } from '@/lib/api-response'
import { queryRows } from '@/lib/db'

export const dynamic = 'force-dynamic'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return apiError('Unauthorized', { status: 401, code: 'UNAUTHORIZED' })
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  const accounts = await queryRows<{
    id: number; email: string; plan: string; status: string; trial_used: number
    active_listings: number; sales_30d: number; created_at: string
  }>`
    SELECT u.id, u.email, u.created_at,
      COALESCE(s.plan, 'trial') AS plan,
      COALESCE(s.status, 'active') AS status,
      COALESCE(s.trial_listings_used, 0)::int AS trial_used,
      (SELECT COUNT(*) FROM listed_asins la WHERE la.user_id = u.id AND la.ended_at IS NULL)::int AS active_listings,
      (SELECT COUNT(*) FROM listed_asins la WHERE la.user_id = u.id AND la.sold_at > NOW() - INTERVAL '30 days')::int AS sales_30d
    FROM users u
    LEFT JOIN user_subscriptions s ON s.user_id = u.id
    ORDER BY active_listings DESC, u.created_at ASC
  `.catch(() => [])

  // ── Source pool (gates inlined — neon tag has no raw-fragment interpolation) ─
  const poolActive = await queryRows<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM product_source_items WHERE active = TRUE
  `.catch(() => [{ n: 0 }])
  const poolReady = await queryRows<{ n: number }>`
    SELECT COUNT(*)::int AS n
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality,'candidate') <> 'reject'
      AND COALESCE(apc.available, TRUE) <> FALSE
      AND apc.fast_fulfillment IS DISTINCT FROM FALSE
      AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
      AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  `.catch(() => [{ n: 0 }])
  const poolMoneyBand = await queryRows<{ n: number }>`
    SELECT COUNT(*)::int AS n
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality,'candidate') <> 'reject'
      AND COALESCE(apc.available, TRUE) <> FALSE
      AND apc.fast_fulfillment IS DISTINCT FROM FALSE
      AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
      AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
      AND psi.amazon_price BETWEEN 25 AND 60
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
  `.catch(() => [{ n: 0 }])
  const topNiches = await queryRows<{ niche: string; ready: number }>`
    SELECT COALESCE(NULLIF(psi.source_niche,''), '(none)') AS niche, COUNT(*)::int AS ready
    FROM product_source_items psi
    LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
    WHERE psi.active = TRUE AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality,'candidate') <> 'reject'
      AND COALESCE(apc.available, TRUE) <> FALSE
      AND apc.fast_fulfillment IS DISTINCT FROM FALSE
      AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
      AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
    GROUP BY 1 ORDER BY 2 DESC LIMIT 8
  `.catch(() => [])

  // ── Sales & money (platform-wide, last 30 days) ───────────────────────────
  const money = await queryRows<{
    active_listings: number; sold_30d: number; revenue_30d: number; profit_30d: number
  }>`
    SELECT
      (SELECT COUNT(*) FROM listed_asins WHERE ended_at IS NULL)::int AS active_listings,
      (SELECT COUNT(*) FROM listed_asins WHERE sold_at > NOW() - INTERVAL '30 days')::int AS sold_30d,
      COALESCE((SELECT SUM(sale_price) FROM listed_asins WHERE sold_at > NOW() - INTERVAL '30 days'), 0)::float AS revenue_30d,
      COALESCE((SELECT SUM(realized_profit) FROM listed_asins WHERE sold_at > NOW() - INTERVAL '30 days'), 0)::float AS profit_30d
  `.catch(() => [])

  // ── System health (is the automation alive?) ──────────────────────────────
  const sourceAgent = await queryRows<{ created_at: string; status: string }>`
    SELECT created_at, status FROM source_agent_runs ORDER BY created_at DESC LIMIT 1
  `.catch(() => [])
  const lastReprice = await queryRows<{ created_at: string }>`
    SELECT created_at FROM reprice_agent_log ORDER BY created_at DESC LIMIT 1
  `.catch(() => [])
  const ebayToday = await queryRows<{ n: number; failed: number }>`
    SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE NOT success)::int AS failed
    FROM api_usage_log WHERE provider = 'ebay' AND created_at > NOW() - INTERVAL '24 hours'
  `.catch(() => [])
  const listFails = await queryRows<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM listing_failure_log WHERE created_at > NOW() - INTERVAL '24 hours'
  `.catch(() => [])

  return apiOk({
    generatedAt: new Date().toISOString(),
    accounts,
    pool: { active: poolActive[0]?.n ?? 0, ready: poolReady[0]?.n ?? 0, money_band: poolMoneyBand[0]?.n ?? 0 },
    topNiches,
    money: money[0] || { active_listings: 0, sold_30d: 0, revenue_30d: 0, profit_30d: 0 },
    health: {
      sourceAgentLastRun: sourceAgent[0]?.created_at || null,
      sourceAgentLastStatus: sourceAgent[0]?.status || null,
      lastRepriceAt: lastReprice[0]?.created_at || null,
      ebayCallsToday: ebayToday[0]?.n ?? 0,
      ebayCallsFailedToday: ebayToday[0]?.failed ?? 0,
      listingFailuresToday: listFails[0]?.n ?? 0,
    },
  })
}
