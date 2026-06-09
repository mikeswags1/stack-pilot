import { queryRows } from '@/lib/db'

export type SourceReadinessStage = {
  key: string
  label: string
  count: number
  dropFromPrevious: number
}

export type SourceReadinessReason = {
  reason: string
  label: string
  count: number
}

export type SourceReadinessAudit = {
  activePool: number
  platformReady: number
  stages: SourceReadinessStage[]
  reasons: SourceReadinessReason[]
}

type AuditRow = Record<string, string | number | null>

const REASON_LABELS: Record<string, string> = {
  sql_ready: 'Platform ready',
  already_listed: 'Already listed',
  bad_economics: 'Bad profit, ROI, risk, image, or source quality',
  unavailable: 'Amazon unavailable',
  missing_cache: 'Missing Amazon cache',
  slow_fulfillment: 'Slow fulfillment',
  slow_delivery: 'Delivery over 8 days',
  too_competitive: 'Too many eBay competitors',
  bad_cost_to_market: 'Amazon cost too high vs eBay market',
  title_blocked: 'Blocked title/category pattern',
  missing_images: 'Missing 2+ cached images',
}

function toNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function stage(key: string, label: string, count: number, previous: number | null): SourceReadinessStage {
  return {
    key,
    label,
    count,
    dropFromPrevious: previous === null ? 0 : Math.max(0, previous - count),
  }
}

export async function getSourceReadinessAudit(): Promise<SourceReadinessAudit> {
  const [row] = await queryRows<AuditRow>`
    WITH base AS (
      SELECT
        psi.asin,
        psi.title,
        psi.amazon_price,
        psi.profit,
        psi.roi,
        psi.risk,
        psi.image_url,
        COALESCE(psi.source_quality, 'candidate') AS source_quality,
        psi.ebay_competitor_count,
        psi.ebay_competitor_min_price,
        apc.asin AS cached_asin,
        apc.available AS cached_available,
        apc.fast_fulfillment AS cached_fast_fulfillment,
        apc.delivery_days_max AS delivery_days_max,
        CASE
          WHEN apc.images IS NOT NULL AND jsonb_typeof(apc.images) = 'array'
          THEN jsonb_array_length(apc.images)
          ELSE 0
        END AS cached_image_count,
        EXISTS (
          SELECT 1
          FROM listed_asins la
          WHERE UPPER(la.asin) = UPPER(psi.asin)
            AND la.ended_at IS NULL
        ) AS already_listed,
        (
          psi.title IS NULL OR (
            psi.title NOT ILIKE '%television%' AND psi.title NOT ILIKE '% tv %'
            AND psi.title NOT ILIKE '%couch%' AND psi.title NOT ILIKE '%sofa%'
            AND psi.title NOT ILIKE '%mattress%' AND psi.title NOT ILIKE '%recliner%'
            AND psi.title NOT ILIKE '%refrigerator%' AND psi.title NOT ILIKE '%treadmill%'
            AND psi.title NOT ILIKE '%kindle%' AND psi.title NOT ILIKE '%echo dot%'
            AND psi.title NOT ILIKE '%fire tv%' AND psi.title NOT ILIKE '%ring doorbell%'
            AND psi.title NOT ILIKE '%t-shirt%' AND psi.title NOT ILIKE '%hoodie%'
            AND psi.title NOT ILIKE '%pants%' AND psi.title NOT ILIKE '%jeans%'
            AND psi.title NOT ILIKE '%dress%' AND psi.title NOT ILIKE '%halter%'
            AND psi.title NOT ILIKE '%tank top%' AND psi.title NOT ILIKE '%jacket%'
            AND psi.title NOT ILIKE '%leggings%' AND psi.title NOT ILIKE '%skirt%'
            AND psi.title NOT ILIKE '%blouse%' AND psi.title NOT ILIKE '%bikini%'
            AND psi.title NOT ILIKE '%swimsuit%' AND psi.title NOT ILIKE '%sweater%'
            AND psi.title NOT ILIKE '%cardigan%'
          )
        ) AS title_safe
      FROM product_source_items psi
      LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
      WHERE psi.active = TRUE
    ),
    classified AS (
      SELECT
        *,
        (
          profit >= 4
          AND roi >= 25
          AND risk <> 'HIGH'
          AND image_url IS NOT NULL
          AND image_url <> ''
          AND source_quality <> 'reject'
        ) AS passes_economics,
        CASE
          WHEN already_listed THEN 'already_listed'
          WHEN NOT (
            profit >= 4
            AND roi >= 25
            AND risk <> 'HIGH'
            AND image_url IS NOT NULL
            AND image_url <> ''
            AND source_quality <> 'reject'
          ) THEN 'bad_economics'
          WHEN cached_available = FALSE THEN 'unavailable'
          WHEN cached_asin IS NULL THEN 'missing_cache'
          WHEN cached_fast_fulfillment IS NOT DISTINCT FROM FALSE THEN 'slow_fulfillment'
          WHEN delivery_days_max IS NOT NULL AND delivery_days_max > 8 THEN 'slow_delivery'
          WHEN ebay_competitor_count IS NOT NULL AND ebay_competitor_count > 50 THEN 'too_competitive'
          WHEN ebay_competitor_min_price IS NOT NULL AND amazon_price >= ebay_competitor_min_price * 1.65 THEN 'bad_cost_to_market'
          WHEN NOT title_safe THEN 'title_blocked'
          WHEN cached_image_count < 2 THEN 'missing_images'
          ELSE 'sql_ready'
        END AS readiness_reason
      FROM base
    )
    SELECT
      COUNT(*)::int AS active,
      COUNT(*) FILTER (WHERE NOT already_listed)::int AS not_listed,
      COUNT(*) FILTER (WHERE NOT already_listed AND passes_economics)::int AS economics,
      COUNT(*) FILTER (WHERE NOT already_listed AND passes_economics AND COALESCE(cached_available, TRUE) <> FALSE AND cached_asin IS NOT NULL)::int AS cache_joined,
      COUNT(*) FILTER (WHERE NOT already_listed AND passes_economics AND COALESCE(cached_available, TRUE) <> FALSE AND cached_asin IS NOT NULL AND cached_fast_fulfillment IS DISTINCT FROM FALSE)::int AS fast_fulfillment,
      COUNT(*) FILTER (WHERE NOT already_listed AND passes_economics AND COALESCE(cached_available, TRUE) <> FALSE AND cached_asin IS NOT NULL AND cached_fast_fulfillment IS DISTINCT FROM FALSE AND (delivery_days_max IS NULL OR delivery_days_max <= 8))::int AS delivery,
      COUNT(*) FILTER (WHERE NOT already_listed AND passes_economics AND COALESCE(cached_available, TRUE) <> FALSE AND cached_asin IS NOT NULL AND cached_fast_fulfillment IS DISTINCT FROM FALSE AND (delivery_days_max IS NULL OR delivery_days_max <= 8) AND (ebay_competitor_count IS NULL OR ebay_competitor_count <= 50))::int AS competition,
      COUNT(*) FILTER (WHERE NOT already_listed AND passes_economics AND COALESCE(cached_available, TRUE) <> FALSE AND cached_asin IS NOT NULL AND cached_fast_fulfillment IS DISTINCT FROM FALSE AND (delivery_days_max IS NULL OR delivery_days_max <= 8) AND (ebay_competitor_count IS NULL OR ebay_competitor_count <= 50) AND (ebay_competitor_min_price IS NULL OR amazon_price < ebay_competitor_min_price * 1.65))::int AS cost_to_market,
      COUNT(*) FILTER (WHERE NOT already_listed AND passes_economics AND COALESCE(cached_available, TRUE) <> FALSE AND cached_asin IS NOT NULL AND cached_fast_fulfillment IS DISTINCT FROM FALSE AND (delivery_days_max IS NULL OR delivery_days_max <= 8) AND (ebay_competitor_count IS NULL OR ebay_competitor_count <= 50) AND (ebay_competitor_min_price IS NULL OR amazon_price < ebay_competitor_min_price * 1.65) AND title_safe)::int AS title_safe,
      COUNT(*) FILTER (WHERE readiness_reason = 'sql_ready')::int AS sql_ready,
      COUNT(*) FILTER (WHERE readiness_reason = 'already_listed')::int AS already_listed,
      COUNT(*) FILTER (WHERE readiness_reason = 'bad_economics')::int AS bad_economics,
      COUNT(*) FILTER (WHERE readiness_reason = 'unavailable')::int AS unavailable,
      COUNT(*) FILTER (WHERE readiness_reason = 'missing_cache')::int AS missing_cache,
      COUNT(*) FILTER (WHERE readiness_reason = 'slow_fulfillment')::int AS slow_fulfillment,
      COUNT(*) FILTER (WHERE readiness_reason = 'slow_delivery')::int AS slow_delivery,
      COUNT(*) FILTER (WHERE readiness_reason = 'too_competitive')::int AS too_competitive,
      COUNT(*) FILTER (WHERE readiness_reason = 'bad_cost_to_market')::int AS bad_cost_to_market,
      COUNT(*) FILTER (WHERE readiness_reason = 'title_blocked')::int AS title_blocked,
      COUNT(*) FILTER (WHERE readiness_reason = 'missing_images')::int AS missing_images
    FROM classified
  `

  const counts = {
    active: toNumber(row?.active),
    notListed: toNumber(row?.not_listed),
    economics: toNumber(row?.economics),
    cacheJoined: toNumber(row?.cache_joined),
    fastFulfillment: toNumber(row?.fast_fulfillment),
    delivery: toNumber(row?.delivery),
    competition: toNumber(row?.competition),
    costToMarket: toNumber(row?.cost_to_market),
    titleSafe: toNumber(row?.title_safe),
    sqlReady: toNumber(row?.sql_ready),
  }

  const stages: SourceReadinessStage[] = []
  let previous: number | null = null
  for (const item of [
    ['active', 'Active source rows', counts.active],
    ['not_listed', 'Not already listed', counts.notListed],
    ['economics', 'Pass profit, ROI, risk, image, and source quality', counts.economics],
    ['cache_joined', 'Amazon cache joined and available', counts.cacheJoined],
    ['fast_fulfillment', 'Fast fulfillment', counts.fastFulfillment],
    ['delivery', 'Delivery 8 days or less', counts.delivery],
    ['competition', '50 or fewer eBay competitors', counts.competition],
    ['cost_to_market', 'Amazon cost below eBay market pressure limit', counts.costToMarket],
    ['title_safe', 'Title/category blocklist safe', counts.titleSafe],
    ['sql_ready', 'Platform ready with 2+ cached images', counts.sqlReady],
  ] as const) {
    stages.push(stage(item[0], item[1], item[2], previous))
    previous = item[2]
  }

  const reasons = Object.keys(REASON_LABELS)
    .map((reason) => ({
      reason,
      label: REASON_LABELS[reason],
      count: toNumber(row?.[reason]),
    }))
    .sort((a, b) => b.count - a.count)

  return {
    activePool: counts.active,
    platformReady: counts.sqlReady,
    stages,
    reasons,
  }
}
