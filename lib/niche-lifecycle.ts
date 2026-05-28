// Phase 1 — Niche lifecycle intelligence.
//
// Reads aggregated per-niche metrics (produced by refreshSourceIntelligenceState) plus the
// 24h failure-log breakdown, then computes:
//
//   1) Lifecycle STATE (active | watch | stale | paused | retired | seasonal_expired)
//   2) Lifecycle REASON (free text — single short sentence shown in UI)
//   3) Structured DIAGNOSTICS (array of {code, severity, detail}) — answers "why unhealthy?"
//
// Seasonal niches get an automatic ramp/decay window — Fourth of July retires after July 5,
// Halloween ramps in late Aug and decays after Nov 1, Christmas ramps Oct → decays Dec 26.
// Auto-pausing is opt-in via the cron route; this module is pure logic and easy to unit-test.

export type LifecycleState =
  | 'active'             // ready_products >= 30 and health >= 70
  | 'watch'              // health 50-69 or thin pool but still salvageable
  | 'stale'              // last_cache_at or last_seen_at >7 days
  | 'paused'             // explicitly disabled by admin (active=FALSE in product_source_niches)
  | 'retired'            // permanent removal — never auto-applied, admin action only
  | 'seasonal_expired'   // past its seasonal window, sourcing/listing should stop

export type DiagnosticCode =
  | 'sourcing_weak'         // not enough new products coming in
  | 'enrichment_weak'       // products sourced but cache/images missing
  | 'preflight_failing'     // ASIN_MISMATCH, PRODUCT_UNAVAILABLE, NO_LISTING_IMAGES dominant
  | 'quota_bottleneck'      // EBAY_QUOTA_BLOCKED / EBAY_API_QUOTA_EXCEEDED dominant
  | 'stale_cache'           // last_cache_at >48h or stale_products >50% of pool
  | 'bad_images'            // NO_LISTING_IMAGES / INSUFFICIENT_LISTING_IMAGES dominant
  | 'bad_category'          // EBAY_LISTING_FAILED with category errors dominant
  | 'unavailable_drift'     // many ASINs going UNAVAILABLE on Amazon (drop-shipped item dead)
  | 'asin_mismatch_drift'   // many ASIN_MISMATCH failures (queue is stale)
  | 'low_margin'            // avg_profit <5 or avg_roi <30 — sourcing is bringing in junk
  | 'no_outcomes'           // no successful listings in 14+ days

export type DiagnosticSeverity = 'info' | 'warn' | 'block'

export type Diagnostic = {
  code: DiagnosticCode
  severity: DiagnosticSeverity
  detail: string
}

export type NicheFunnelInput = {
  niche: string
  // From source_niche_intelligence
  activeProducts: number
  readyProducts: number
  cacheProducts: number
  staleProducts: number
  unavailableProducts: number
  listed30d: number
  completedQueue30d: number
  failedQueue30d: number
  avgProfit: number
  avgRoi: number
  healthScore: number
  lastCacheAt: string | null
  lastSeenAt: string | null
  lastSuccessfulListingAt: string | null
  // Derived (joined fresh)
  enrichedProducts: number             // active_products WITH cache row AND ≥2 images
  preflightFailures24h: number         // count from listing_failure_log
  // Top-N failure codes from listing_failure_log scoped to this niche
  topFailureCodes: Array<{ code: string; count: number }>
  // Whether admin disabled it
  paused: boolean
}

export type LifecycleAssessment = {
  state: LifecycleState
  reason: string
  diagnostics: Diagnostic[]
  // True if our logic recommends auto-pausing the niche (cron will set active=FALSE)
  recommendPause: boolean
}

// ────────────────────────────── Seasonal windows ──────────────────────────────
//
// monthDay = month * 100 + day (e.g. July 4 = 704).
// `rampStart` = when sourcing should resume / become viable.
// `peakEnd`   = last day to keep listings live; past this we mark seasonal_expired.
// `retireGrace` = days past peakEnd before we suggest deactivation (lets in-flight orders ship).

export type SeasonalWindow = {
  rampStart: number   // monthDay (101–1231)
  peakEnd: number     // monthDay
  retireGraceDays: number
}

export const SEASONAL_WINDOWS: Record<string, SeasonalWindow> = {
  'Fourth of July':              { rampStart: 501,  peakEnd: 705,  retireGraceDays: 10 },
  'Halloween Party Decor':       { rampStart: 815,  peakEnd: 1101, retireGraceDays: 7 },
  'Back to School Organization': { rampStart: 615,  peakEnd: 915,  retireGraceDays: 7 },
  'Holiday Gift Wrap & Shipping':{ rampStart: 1001, peakEnd: 1226, retireGraceDays: 14 },
  'Christmas Decorations':       { rampStart: 1015, peakEnd: 1226, retireGraceDays: 14 },
  'Valentine\'s Day':            { rampStart: 115,  peakEnd: 215,  retireGraceDays: 7 },
  'Easter':                      { rampStart: 215,  peakEnd: 415,  retireGraceDays: 7 },
  'Mother\'s Day':               { rampStart: 401,  peakEnd: 515,  retireGraceDays: 7 },
  'Father\'s Day':               { rampStart: 501,  peakEnd: 622,  retireGraceDays: 7 },
  'Thanksgiving':                { rampStart: 1015, peakEnd: 1130, retireGraceDays: 7 },
  'Super Bowl':                  { rampStart: 1215, peakEnd: 215,  retireGraceDays: 7 }, // wraps year
  'Black Friday':                { rampStart: 1101, peakEnd: 1205, retireGraceDays: 7 },
}

function getMonthDay(date: Date): number {
  return (date.getUTCMonth() + 1) * 100 + date.getUTCDate()
}

function withinWindow(monthDay: number, rampStart: number, peakEnd: number): boolean {
  if (rampStart <= peakEnd) {
    // Normal: e.g. 501..705 — within if monthDay is between
    return monthDay >= rampStart && monthDay <= peakEnd
  }
  // Wrap-around: e.g. 1215..215 (Dec 15 → Feb 15)
  return monthDay >= rampStart || monthDay <= peakEnd
}

function daysPast(monthDay: number, peakEnd: number, year: number): number {
  // Compute days between today and the most recent peakEnd boundary.
  const now = new Date()
  const peakDate = new Date(Date.UTC(year, Math.floor(peakEnd / 100) - 1, peakEnd % 100))
  // If we're in the next year already (e.g. peak was Dec 26, now is Jan 5), use last year's peak.
  if (peakDate.getTime() > now.getTime()) peakDate.setUTCFullYear(year - 1)
  return Math.floor((now.getTime() - peakDate.getTime()) / 86_400_000)
}

export type SeasonalStatus = 'in_window' | 'pre_window' | 'post_window' | 'not_seasonal'

export function getSeasonalStatus(niche: string, now = new Date()): {
  status: SeasonalStatus
  window: SeasonalWindow | null
  shouldRetire: boolean
} {
  const window = SEASONAL_WINDOWS[niche]
  if (!window) return { status: 'not_seasonal', window: null, shouldRetire: false }
  const monthDay = getMonthDay(now)
  if (withinWindow(monthDay, window.rampStart, window.peakEnd)) {
    return { status: 'in_window', window, shouldRetire: false }
  }
  // Out of window — decide whether we're past peakEnd (and how many days past)
  const daysPastPeak = daysPast(monthDay, window.peakEnd, now.getUTCFullYear())
  const shouldRetire = daysPastPeak > window.retireGraceDays
  // Pre-window if we're before rampStart this year (and not just barely past peakEnd)
  const beforeRamp = monthDay < window.rampStart && daysPastPeak > 60
  return {
    status: beforeRamp ? 'pre_window' : 'post_window',
    window,
    shouldRetire,
  }
}

// ────────────────────────────── Diagnostics ──────────────────────────────

function topCode(input: NicheFunnelInput, ...codes: string[]): { code: string; count: number } | null {
  for (const c of codes) {
    const hit = input.topFailureCodes.find((entry) => entry.code === c)
    if (hit && hit.count > 0) return hit
  }
  return null
}

function pct(value: number, total: number): number {
  return total > 0 ? value / total : 0
}

export function computeDiagnostics(input: NicheFunnelInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const totalFailures = input.topFailureCodes.reduce((sum, entry) => sum + entry.count, 0)

  // 1. Sourcing weak — pool isn't growing
  if (input.activeProducts < 20) {
    diagnostics.push({
      code: 'sourcing_weak',
      severity: 'warn',
      detail: `Only ${input.activeProducts} active source products. Sourcing needs to bring in more.`,
    })
  }

  // 2. Enrichment weak — products exist but not enriched to ready
  if (input.activeProducts >= 30 && pct(input.enrichedProducts, input.activeProducts) < 0.4) {
    diagnostics.push({
      code: 'enrichment_weak',
      severity: 'warn',
      detail: `${input.enrichedProducts}/${input.activeProducts} active products enriched (<40%). RapidAPI/cache refresh likely lagging.`,
    })
  }

  // 3. Quota bottleneck — eBay quota the dominant failure
  const quotaFail = topCode(input, 'EBAY_QUOTA_BLOCKED', 'EBAY_API_QUOTA_EXCEEDED')
  if (quotaFail && pct(quotaFail.count, totalFailures) > 0.3) {
    diagnostics.push({
      code: 'quota_bottleneck',
      severity: 'block',
      detail: `${quotaFail.count} listings blocked by eBay quota in last 24h. Pipeline can't drain.`,
    })
  }

  // 4. Preflight failing — ASIN_MISMATCH/PRODUCT_UNAVAILABLE/AMAZON_LIVE_CHECK_FAILED dominate
  const preflightFail = (input.topFailureCodes.find((e) => e.code === 'ASIN_MISMATCH')?.count || 0) +
    (input.topFailureCodes.find((e) => e.code === 'PRODUCT_UNAVAILABLE')?.count || 0) +
    (input.topFailureCodes.find((e) => e.code === 'AMAZON_LIVE_CHECK_FAILED')?.count || 0)
  if (preflightFail > 3 && pct(preflightFail, totalFailures) > 0.5) {
    diagnostics.push({
      code: 'preflight_failing',
      severity: 'warn',
      detail: `${preflightFail} preflight failures (mismatch/unavailable). Queue contains stale or dead ASINs.`,
    })
  }

  // 5. ASIN mismatch drift — sub-case of preflight, but specific
  const mismatchFail = input.topFailureCodes.find((e) => e.code === 'ASIN_MISMATCH')?.count || 0
  if (mismatchFail > 5) {
    diagnostics.push({
      code: 'asin_mismatch_drift',
      severity: 'warn',
      detail: `${mismatchFail} ASIN_MISMATCH failures — Amazon is remapping ASINs to different products. Re-source this niche.`,
    })
  }

  // 6. Bad images — NO_LISTING_IMAGES / INSUFFICIENT_LISTING_IMAGES dominate
  const imageFail = (input.topFailureCodes.find((e) => e.code === 'NO_LISTING_IMAGES')?.count || 0) +
    (input.topFailureCodes.find((e) => e.code === 'INSUFFICIENT_LISTING_IMAGES')?.count || 0)
  if (imageFail > 3) {
    diagnostics.push({
      code: 'bad_images',
      severity: 'warn',
      detail: `${imageFail} listings blocked for missing/insufficient images. Cache freshness or Amazon scrape issue.`,
    })
  }

  // 7. Bad category — EBAY_LISTING_FAILED dominant (likely category mapping issue)
  const ebayFail = input.topFailureCodes.find((e) => e.code === 'EBAY_LISTING_FAILED')?.count || 0
  if (ebayFail > 5 && pct(ebayFail, totalFailures) > 0.4) {
    diagnostics.push({
      code: 'bad_category',
      severity: 'warn',
      detail: `${ebayFail} eBay rejections — likely wrong category mapping or item specifics missing.`,
    })
  }

  // 8. Stale cache
  const cacheLagH = input.lastCacheAt
    ? Math.floor((Date.now() - new Date(input.lastCacheAt).getTime()) / 3_600_000)
    : Infinity
  if (cacheLagH > 48) {
    diagnostics.push({
      code: 'stale_cache',
      severity: cacheLagH > 168 ? 'block' : 'warn',
      detail: cacheLagH === Infinity
        ? 'Niche cache has never been built.'
        : `Niche cache is ${cacheLagH}h old (>48h threshold). Repricing decisions may be based on old data.`,
    })
  }

  // 9. Unavailable drift — many ASINs went dead on Amazon
  if (input.unavailableProducts > Math.max(10, input.activeProducts * 0.2)) {
    diagnostics.push({
      code: 'unavailable_drift',
      severity: 'warn',
      detail: `${input.unavailableProducts} products marked unavailable on Amazon. Re-source replacements.`,
    })
  }

  // 10. Low margin — sourcing bringing in junk
  if (input.activeProducts >= 20 && (input.avgProfit < 5 || input.avgRoi < 30)) {
    diagnostics.push({
      code: 'low_margin',
      severity: 'info',
      detail: `Avg profit $${input.avgProfit.toFixed(2)} / ROI ${Math.round(input.avgRoi)}%. Sourcing thresholds may need raising.`,
    })
  }

  // 11. No recent outcomes — niche has products but isn't producing sales/listings
  if (input.lastSuccessfulListingAt) {
    const daysSince = Math.floor((Date.now() - new Date(input.lastSuccessfulListingAt).getTime()) / 86_400_000)
    if (daysSince > 14 && input.readyProducts >= 30) {
      diagnostics.push({
        code: 'no_outcomes',
        severity: 'warn',
        detail: `${daysSince} days since last successful listing despite ${input.readyProducts} ready products.`,
      })
    }
  } else if (input.readyProducts >= 30) {
    diagnostics.push({
      code: 'no_outcomes',
      severity: 'warn',
      detail: `Niche has ${input.readyProducts} ready products but no successful listings on record.`,
    })
  }

  return diagnostics
}

// ────────────────────────────── State + reason ──────────────────────────────

export function computeLifecycleState(input: NicheFunnelInput, now = new Date()): LifecycleAssessment {
  const seasonal = getSeasonalStatus(input.niche, now)
  const diagnostics = computeDiagnostics(input)

  // Highest-precedence outcomes first.

  // Admin pause overrides everything.
  if (input.paused) {
    return {
      state: 'paused',
      reason: 'Admin manually paused this niche.',
      diagnostics,
      recommendPause: false,
    }
  }

  // Seasonal expired (past the retireGrace window).
  if (seasonal.shouldRetire) {
    return {
      state: 'seasonal_expired',
      reason: `Past peak season window (${seasonal.window?.peakEnd}). Sourcing/listing should stop until next cycle.`,
      diagnostics,
      recommendPause: true,
    }
  }

  // Stale: no fresh data for 7+ days from EITHER source pool or cache.
  const lastSeenLagDays = input.lastSeenAt
    ? Math.floor((Date.now() - new Date(input.lastSeenAt).getTime()) / 86_400_000)
    : 9999
  const lastCacheLagDays = input.lastCacheAt
    ? Math.floor((Date.now() - new Date(input.lastCacheAt).getTime()) / 86_400_000)
    : 9999
  if (lastSeenLagDays > 7 && lastCacheLagDays > 7 && input.activeProducts < 30) {
    return {
      state: 'stale',
      reason: `No fresh sourcing for ${lastSeenLagDays}d and stale cache (${lastCacheLagDays}d). Refresh or retire.`,
      diagnostics,
      recommendPause: false,
    }
  }

  // Quota bottleneck → watch (don't downgrade further; it's a system issue not a niche issue)
  if (diagnostics.some((d) => d.code === 'quota_bottleneck')) {
    return {
      state: 'watch',
      reason: 'eBay quota blocking listings — system bottleneck, not niche health.',
      diagnostics,
      recommendPause: false,
    }
  }

  // Active: high health, deep ready pool.
  if (input.healthScore >= 70 && input.readyProducts >= 30) {
    return {
      state: 'active',
      reason: `Healthy (health ${input.healthScore}, ${input.readyProducts} ready).`,
      diagnostics,
      recommendPause: false,
    }
  }

  // Watch: somewhat usable but degraded.
  if (input.healthScore >= 50 || input.readyProducts >= 15) {
    const blockers = diagnostics.filter((d) => d.severity === 'block')
    const reason = blockers[0]?.detail
      || diagnostics[0]?.detail
      || `Below ready threshold (${input.readyProducts} ready, health ${input.healthScore}).`
    return {
      state: 'watch',
      reason,
      diagnostics,
      recommendPause: false,
    }
  }

  // Stale fallback: low health, thin pool — recommend pause but don't auto-execute.
  return {
    state: 'stale',
    reason: `Low health (${input.healthScore}) with only ${input.readyProducts} ready. Needs intervention.`,
    diagnostics,
    recommendPause: false,
  }
}

// ────────────────────────────── State pill helpers (UI) ──────────────────────────────

export function stateToTone(state: LifecycleState): 'good' | 'watch' | 'bad' | 'neutral' {
  switch (state) {
    case 'active': return 'good'
    case 'watch': return 'watch'
    case 'stale': return 'bad'
    case 'paused': return 'neutral'
    case 'retired': return 'neutral'
    case 'seasonal_expired': return 'neutral'
    default: return 'neutral'
  }
}

export function stateLabel(state: LifecycleState): string {
  switch (state) {
    case 'active': return 'Active'
    case 'watch': return 'Watch'
    case 'stale': return 'Stale'
    case 'paused': return 'Paused'
    case 'retired': return 'Retired'
    case 'seasonal_expired': return 'Seasonal Off'
    default: return state
  }
}

export function diagnosticLabel(code: DiagnosticCode): string {
  const labels: Record<DiagnosticCode, string> = {
    sourcing_weak: 'Sourcing weak',
    enrichment_weak: 'Enrichment weak',
    preflight_failing: 'Preflight failing',
    quota_bottleneck: 'Quota bottleneck',
    stale_cache: 'Stale cache',
    bad_images: 'Image issues',
    bad_category: 'Category issues',
    unavailable_drift: 'Unavailable drift',
    asin_mismatch_drift: 'ASIN mismatch drift',
    low_margin: 'Low margin',
    no_outcomes: 'No outcomes',
  }
  return labels[code] || code
}
