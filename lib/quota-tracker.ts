// Quota tracker — records every external API call we make and exposes throttle gates.
//
// Goals:
//   1) Visibility — know exactly how many eBay/RapidAPI/Anthropic calls we've burned today
//   2) Protection — refuse to start jobs that will obviously bust the quota and fail
//   3) Failure forensics — every listing failure logged with the exact eBay/system error
//
// Designed for Phase 0 only. Read paths are not cached (current traffic is low).
// When usage grows, swap getQuotaSummary's queries for a materialized view or in-memory cache.

import { queryRows, sql } from '@/lib/db'

// ────────────────────────────── Provider constants ──────────────────────────────

export type ApiProvider = 'ebay' | 'rapidapi' | 'anthropic' | 'amazon-scrape' | 'openrouter' | 'scraperapi'

/**
 * Conservative limits per provider × call. Tuned to typical defaults; warnings fire well
 * before hard limits to give StackPilot a soft braking distance.
 *
 *   warnPct  = show yellow banner + soft-throttle cron jobs (skip auto-listing, slow reprice)
 *   blockPct = show red banner + REFUSE new manual listings, hard-stop crons
 */
export const QUOTA_RULES = {
  ebay: {
    // Trading API: production-app defaults per call name. Combine to total daily eBay budget.
    AddFixedPriceItem:           { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    VerifyAddFixedPriceItem:     { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    ReviseFixedPriceItem:        { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    UploadSiteHostedPictures:    { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    EndItem:                     { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    GetSuggestedCategories:      { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    GetCategoryFeatures:         { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    BrowseSearch:                { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    TaxonomyCategory:            { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
    // Catch-all bucket so we can track totals across the app even if a call isn't itemized.
    Other:                       { dailyHardLimit: 5000, hourlyHardLimit: 1500, warnPct: 0.70, blockPct: 0.90 },
  },
  rapidapi: {
    // RapidAPI Pro tier = 10,000/month ≈ 333/day budget. Tighter limits since plan size matters.
    'product-details':           { dailyHardLimit: 333,  hourlyHardLimit: 100,  warnPct: 0.70, blockPct: 0.90 },
    Other:                       { dailyHardLimit: 333,  hourlyHardLimit: 100,  warnPct: 0.70, blockPct: 0.90 },
  },
  anthropic: {
    // Cost-bounded rather than rate-bounded. ~$0.001 per call (Haiku) — soft caps for cost control.
    Other:                       { dailyHardLimit: 5000, hourlyHardLimit: 1000, warnPct: 0.80, blockPct: 0.95 },
  },
  openrouter: {
    Other:                       { dailyHardLimit: 5000, hourlyHardLimit: 1000, warnPct: 0.80, blockPct: 0.95 },
  },
  'amazon-scrape': {
    // Free / unmetered scraping. Track for diagnostics, no throttle.
    Other:                       { dailyHardLimit: 100000, hourlyHardLimit: 50000, warnPct: 0.99, blockPct: 1.0 },
  },
  scraperapi: {
    // Hobby plan: 100k credits/month, Amazon structured = 5 credits/request ⇒ ~20k requests/mo.
    // Tightened 7/4 after day-1 burn ran ~5.9k credits/day (100k pace breach): 400 requests/day
    // = 2k credits/day = ~60k/mo worst case, leaving ~40k for audits + scout. Enrichment
    // processes best-scored products first, so the cap trims the tail, not the winners.
    // Plan is "Interrupted Scraping" (never overbills) — this cap prevents runaway loops.
    // 7/6 rebalance: product-enrichment trimmed 400→300/day to fund 6x-daily scout hunts
    // (search bucket) — discovery is the growth constraint, enrichment was half-idle.
    // 7/11 rebalance: total burn hit ~4.3k credits/day (enrichment + scout + the cloud
    // audit sweep combined) — on pace to exhaust the tank by ~Jul 20 and then PAUSE for
    // two weeks. These caps land the remaining 37k credits exactly on the Aug 3 reset:
    // ~330 requests/day total ≈ 1,650 credits/day. Slower but never stops.
    // 7/13 partition (total UNCHANGED at 160 product-calls/day): 40 of the 160 are
    // carved out as a listing-time fallback bucket. Amazon bot-blocks ~95% of free
    // page reads from Vercel, so the LIVE-price listing gate was rejecting nearly
    // every autopilot listing. The fallback pays 1 verified read ONLY when a listing
    // is otherwise ready to post — the highest-yield paid call in the whole pipeline.
    // 7/13 second rebalance (total STILL 160/day, 40/hr combined): the enriched pool
    // is deep (900+) while the listing gate — the only step that converts pool into
    // live listings — was starved at 40/day. Listing conversion now gets the majority.
    // Snap back toward enrichment when the pool thins.
    'structured-product':        { dailyHardLimit: 60,   hourlyHardLimit: 12,   warnPct: 0.70, blockPct: 0.90 },
    'structured-product-listing': { dailyHardLimit: 100, hourlyHardLimit: 28,   warnPct: 0.85, blockPct: 1.0 },
    'structured-search':         { dailyHardLimit: 120,  hourlyHardLimit: 40,   warnPct: 0.70, blockPct: 0.90 },
    Other:                       { dailyHardLimit: 60,   hourlyHardLimit: 20,   warnPct: 0.70, blockPct: 0.90 },
  },
} satisfies Record<ApiProvider, Record<string, QuotaRule>>

type QuotaRule = {
  dailyHardLimit: number
  hourlyHardLimit: number
  warnPct: number
  blockPct: number
}

function getRule(provider: ApiProvider, callName: string): QuotaRule {
  const providerRules = QUOTA_RULES[provider] as Record<string, QuotaRule> | undefined
  return providerRules?.[callName] || providerRules?.Other || QUOTA_RULES.ebay.Other
}

// ────────────────────────────── Schema ──────────────────────────────

export async function ensureQuotaTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS api_usage_log (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      call_name TEXT NOT NULL,
      user_id INTEGER,
      success BOOLEAN NOT NULL,
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS api_usage_log_provider_time_idx ON api_usage_log (provider, call_name, created_at DESC)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS api_usage_log_failures_idx ON api_usage_log (created_at DESC) WHERE success = FALSE`.catch(() => {})

  await sql`
    CREATE TABLE IF NOT EXISTS listing_failure_log (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER,
      asin TEXT,
      niche TEXT,
      error_code TEXT NOT NULL,
      error_message TEXT,
      ebay_response TEXT,
      stage TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listing_failure_log_time_idx ON listing_failure_log (created_at DESC)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS listing_failure_log_code_idx ON listing_failure_log (error_code, created_at DESC)`.catch(() => {})

  // Paid-verification attribution: one row per paid listing-verification call, with
  // the queue job it served and how the listing attempt ended. Makes credits-per-
  // successful-listing genuinely computable instead of inferred.
  await sql`
    CREATE TABLE IF NOT EXISTS paid_verification_log (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER,
      asin TEXT,
      queue_id BIGINT,
      paid_call_ok BOOLEAN,
      outcome TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`ALTER TABLE paid_verification_log ADD COLUMN IF NOT EXISTS usage_log_id BIGINT`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS paid_verification_log_pending_idx ON paid_verification_log (user_id, asin, created_at DESC) WHERE outcome = 'pending'`.catch(() => {})

  // Atomic quota counters — the enforcement source of truth for paid calls.
  // Row-level locking on the UPSERT makes concurrent reservations strictly serial
  // per (provider, call, day) with no advisory locks and no COUNT(*) races.
  await sql`
    CREATE TABLE IF NOT EXISTS quota_counters (
      provider TEXT NOT NULL,
      call_name TEXT NOT NULL,
      day_key TEXT NOT NULL,
      hour_key TEXT NOT NULL,
      day_count INTEGER NOT NULL DEFAULT 0,
      hour_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, call_name, day_key)
    )
  `.catch(() => {})
}

// ────────────────────────────── Write paths ──────────────────────────────

export type RecordApiCallInput = {
  provider: ApiProvider
  callName: string
  userId?: number | string
  success: boolean
  durationMs?: number
  errorCode?: string
  errorMessage?: string
}

/** Fire-and-forget logging. Never throws. */
export async function recordApiCall(input: RecordApiCallInput): Promise<void> {
  await ensureQuotaTables()
  const userId = input.userId ? Number(input.userId) : null
  await sql`
    INSERT INTO api_usage_log (provider, call_name, user_id, success, duration_ms, error_code, error_message)
    VALUES (
      ${input.provider},
      ${input.callName.slice(0, 60)},
      ${Number.isFinite(userId) ? userId : null},
      ${input.success},
      ${input.durationMs ?? null},
      ${input.errorCode?.slice(0, 60) || null},
      ${input.errorMessage?.slice(0, 500) || null}
    )
  `.catch(() => {})
}

export type RecordListingFailureInput = {
  userId?: number | string
  asin?: string
  niche?: string | null
  errorCode: string
  errorMessage?: string
  ebayResponse?: string
  /**
   * Free-form pipeline stage label — kept loose so callers can record granular forensic
   * context (e.g. "asin_validation", "amazon_live_check", "eps_upload", "ebay_submit").
   * Truncated to 40 chars at the DB.
   */
  stage?: string
  source?: 'manual' | 'cron' | 'bulk' | 'api' | 'unknown'
  /** Arbitrary JSON-serializable diagnostic blob. Stored as JSON text in ebay_response. */
  raw?: unknown
}

/** Log a listing failure with full forensic context. Always called when listing pipeline fails. */
export async function recordListingFailure(input: RecordListingFailureInput): Promise<void> {
  await ensureQuotaTables()
  const userId = input.userId ? Number(input.userId) : null
  let responseBlob: string | null = null
  if (input.ebayResponse) {
    responseBlob = input.ebayResponse.slice(0, 2000)
  } else if (input.raw !== undefined) {
    try { responseBlob = JSON.stringify(input.raw).slice(0, 2000) } catch { responseBlob = null }
  }
  await sql`
    INSERT INTO listing_failure_log (user_id, asin, niche, error_code, error_message, ebay_response, stage, source)
    VALUES (
      ${Number.isFinite(userId) ? userId : null},
      ${input.asin?.slice(0, 12) || null},
      ${input.niche?.slice(0, 80) || null},
      ${input.errorCode.slice(0, 60)},
      ${input.errorMessage?.slice(0, 500) || null},
      ${responseBlob},
      ${(input.stage || 'other').slice(0, 40)},
      ${input.source || 'unknown'}
    )
  `.catch(() => {})
  // Stamp the verdict onto any open paid-verification row for this attempt so
  // every spent credit ends attributed to a concrete outcome.
  if (input.asin) {
    await sql`
      UPDATE paid_verification_log
      SET outcome = ${input.errorCode.slice(0, 60)}
      WHERE outcome = 'pending'
        AND asin = ${input.asin.slice(0, 12)}
        AND user_id = ${Number.isFinite(userId as number) ? userId : null}
        AND created_at > NOW() - INTERVAL '15 minutes'
    `.catch(() => {})
  }
}

/**
 * Wrap any async function call so its usage is automatically recorded.
 * Returns the function's result on success, rethrows on failure (after logging).
 */
export async function trackApiCall<T>(
  meta: Pick<RecordApiCallInput, 'provider' | 'callName' | 'userId'>,
  fn: () => Promise<T>,
  options: { errorCodeFromError?: (err: unknown) => string | undefined } = {}
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await fn()
    recordApiCall({ ...meta, success: true, durationMs: Date.now() - startedAt }).catch(() => {})
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code = options.errorCodeFromError ? options.errorCodeFromError(err) : undefined
    recordApiCall({
      ...meta,
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: message,
      errorCode: code,
    }).catch(() => {})
    throw err
  }
}

// ────────────────────────────── Atomic reservation ──────────────────────────────

export type QuotaReservation = { ok: true; logId: number } | { ok: false; reason: 'daily_cap' | 'hourly_cap' | 'error' }

/**
 * Atomically reserve one quota slot BEFORE making a paid call. Fail-closed:
 * if the reservation cannot be recorded, the caller must not make the call.
 *
 * Enforcement is a single UPSERT on quota_counters — Postgres row locking makes
 * concurrent increments strictly serial per (provider, call, day), so the last
 * slot can only be taken once. The counter is the source of truth; the usage-log
 * row is written afterwards purely for reporting and cannot loosen enforcement.
 * Call settleQuotaReservation afterwards to stamp success/duration on the log row.
 */
export async function reserveQuotaSlot(
  provider: ApiProvider,
  callName: string,
  userId?: number | string
): Promise<QuotaReservation> {
  await ensureQuotaTables()
  const rule = getRule(provider, callName)
  const uid = userId ? Number(userId) : null
  try {
    const rows = await queryRows<{ day_count: number; hour_count: number }>`
      INSERT INTO quota_counters (provider, call_name, day_key, hour_key, day_count, hour_count)
      VALUES (
        ${provider},
        ${callName.slice(0, 60)},
        (NOW() AT TIME ZONE 'America/Los_Angeles')::date::text,
        to_char(NOW(), 'YYYY-MM-DD-HH24'),
        1, 1
      )
      ON CONFLICT (provider, call_name, day_key) DO UPDATE SET
        day_count = quota_counters.day_count + 1,
        hour_count = CASE
          WHEN quota_counters.hour_key = EXCLUDED.hour_key THEN quota_counters.hour_count + 1
          ELSE 1
        END,
        hour_key = EXCLUDED.hour_key,
        updated_at = NOW()
      WHERE quota_counters.day_count < ${rule.dailyHardLimit}
        AND (CASE WHEN quota_counters.hour_key = EXCLUDED.hour_key THEN quota_counters.hour_count ELSE 0 END) < ${rule.hourlyHardLimit}
      RETURNING day_count, hour_count
    `
    if (rows.length === 0) {
      // Cap reached — figure out which one for the caller's telemetry.
      const state = await queryRows<{ day_count: number }>`
        SELECT day_count FROM quota_counters
        WHERE provider = ${provider} AND call_name = ${callName.slice(0, 60)}
          AND day_key = (NOW() AT TIME ZONE 'America/Los_Angeles')::date::text
      `.catch(() => [])
      const dayCount = Number(state[0]?.day_count ?? rule.dailyHardLimit)
      return { ok: false, reason: dayCount >= rule.dailyHardLimit ? 'daily_cap' : 'hourly_cap' }
    }
    // Reporting row (does not gate anything — the counter above already enforced).
    const logRows = await queryRows<{ id: number }>`
      INSERT INTO api_usage_log (provider, call_name, user_id, success, error_code)
      VALUES (${provider}, ${callName.slice(0, 60)}, ${Number.isFinite(uid as number) ? uid : null}, TRUE, 'reserved')
      RETURNING id
    `.catch(() => [])
    return { ok: true, logId: Number(logRows[0]?.id ?? -1) }
  } catch {
    // Fail-closed: if we cannot prove there is budget, there is no budget.
    return { ok: false, reason: 'error' }
  }
}

/** Stamp the outcome onto a previously reserved slot. The row already counts against quota either way. */
export async function settleQuotaReservation(
  logId: number,
  outcome: { success: boolean; durationMs?: number; errorCode?: string; errorMessage?: string }
): Promise<void> {
  await sql`
    UPDATE api_usage_log
    SET success = ${outcome.success},
        duration_ms = ${outcome.durationMs ?? null},
        error_code = ${outcome.errorCode?.slice(0, 60) || null},
        error_message = ${outcome.errorMessage?.slice(0, 500) || null}
    WHERE id = ${logId}
  `.catch(() => {})
}

// ────────────────────────────── Read / aggregate ──────────────────────────────

export type ProviderUsageSummary = {
  provider: ApiProvider
  callName: string
  rule: QuotaRule
  dailyUsage: number
  hourlyUsage: number
  dailyPct: number
  hourlyPct: number
  status: 'ok' | 'warn' | 'block'
  recentFailures: number
}

/** Snapshot of current usage vs rules across all providers/calls. */
export async function getQuotaSummary(): Promise<ProviderUsageSummary[]> {
  await ensureQuotaTables()
  const rows = await queryRows<{
    provider: string
    call_name: string
    daily_usage: string | number
    hourly_usage: string | number
    daily_failures: string | number
  }>`
    -- eBay counts EVERY call against the daily limit — success OR failure. So usage
    -- must count both (a failure storm burns real quota too). The daily window is
    -- "since midnight Pacific" to match eBay's actual reset, so the brake clears when
    -- eBay's allowance does instead of staying stuck on a rolling 24h of old failures.
    SELECT
      provider,
      call_name,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles')::int AS daily_usage,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS hourly_usage,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles' AND success = FALSE)::int AS daily_failures
    FROM api_usage_log
    WHERE created_at > NOW() - INTERVAL '25 hours'
    GROUP BY provider, call_name
  `.catch(() => [])

  return rows.map((row) => {
    const provider = row.provider as ApiProvider
    const rule = getRule(provider, row.call_name)
    const dailyUsage = Number(row.daily_usage)
    const hourlyUsage = Number(row.hourly_usage)
    const dailyPct = Math.min(1, dailyUsage / rule.dailyHardLimit)
    const hourlyPct = Math.min(1, hourlyUsage / rule.hourlyHardLimit)
    const worstPct = Math.max(dailyPct, hourlyPct)
    const status: 'ok' | 'warn' | 'block' =
      worstPct >= rule.blockPct ? 'block' :
      worstPct >= rule.warnPct ? 'warn' : 'ok'
    return {
      provider,
      callName: row.call_name,
      rule,
      dailyUsage,
      hourlyUsage,
      dailyPct,
      hourlyPct,
      status,
      recentFailures: Number(row.daily_failures),
    }
  })
}

/**
 * Throttle decision — returns the strongest signal across all calls for the given provider.
 *   'block' → refuse new work (manual listings get blocked too)
 *   'warn'  → soft-throttle (skip crons, allow user-initiated work)
 *   'ok'    → proceed
 *
 * If callName is omitted, checks the worst call across the provider.
 */
export async function getThrottleState(provider: ApiProvider, callName?: string): Promise<'ok' | 'warn' | 'block'> {
  const summary = await getQuotaSummary()
  const relevant = summary.filter((entry) => entry.provider === provider && (!callName || entry.callName === callName))
  if (relevant.length === 0) return 'ok'
  if (relevant.some((entry) => entry.status === 'block')) return 'block'
  if (relevant.some((entry) => entry.status === 'warn')) return 'warn'
  return 'ok'
}

export async function shouldBlockManualListing(): Promise<boolean> {
  return (await getThrottleState('ebay')) === 'block'
}

export async function shouldSkipCronListing(): Promise<boolean> {
  const state = await getThrottleState('ebay')
  return state === 'block' || state === 'warn'
}
