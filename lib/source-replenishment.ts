import { queryRows, sql } from '@/lib/db'
import { getSourceReadinessAudit, type SourceReadinessAudit } from '@/lib/source-readiness-audit'
import { getDiscoverySettings, getSourcingBreadthMetrics, runGraphDiscovery } from '@/lib/source-graph'
import { enrichTopCandidates } from '@/lib/staged-enrichment'
import { loadProductSourceProducts } from '@/lib/product-source-engine'
import { getThrottleState } from '@/lib/quota-tracker'

const CONTINUOUS_CACHE_KEY = '__continuous_listing__'
const CACHE_VERSION = 6

type ReplenishmentOptions = {
  platformTarget?: number
  rawCandidateTarget?: number
  maxRuntimeMs?: number
  force?: boolean
  dryRun?: boolean
}

type ReplenishmentStep = {
  step: string
  status: 'ran' | 'skipped' | 'failed'
  reason?: string
  metrics?: unknown
}

export type ReplenishmentRunResult = {
  ok: boolean
  mode: 'healthy' | 'replenished' | 'dry-run' | 'disabled'
  platformTarget: number
  rawCandidateTarget: number
  before: SourceReadinessAudit
  after: SourceReadinessAudit
  rawCandidatesBefore: number
  rawCandidatesAfter: number
  continuousSnapshotProducts: number
  steps: ReplenishmentStep[]
  durationMs: number
}

function toNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

async function countRawCandidates() {
  const [row] = await queryRows<{ n: string | number }>`
    SELECT COUNT(*)::int AS n
    FROM product_source_items
    WHERE active = TRUE
      AND enrichment_status = 'raw'
      AND COALESCE(source_quality, 'candidate') <> 'reject'
      AND COALESCE(enrichment_attempts, 0) < 2
  `.catch(() => [])
  return toNumber(row?.n)
}

async function refreshContinuousReadySnapshot(limit = 600) {
  await sql`
    CREATE TABLE IF NOT EXISTS product_cache (
      niche TEXT PRIMARY KEY,
      results JSONB NOT NULL,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      version INTEGER NOT NULL DEFAULT 1
    )
  `.catch(() => {})
  await sql`ALTER TABLE product_cache ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`.catch(() => {})

  const products = await loadProductSourceProducts({ limit }).catch(() => [])
  await sql`
    INSERT INTO product_cache (niche, results, version)
    VALUES (${CONTINUOUS_CACHE_KEY}, ${JSON.stringify(products)}, ${CACHE_VERSION})
    ON CONFLICT (niche) DO UPDATE SET
      results = EXCLUDED.results,
      version = EXCLUDED.version,
      cached_at = NOW()
  `.catch(() => {})
  return products.length
}

async function logRun(result: ReplenishmentRunResult) {
  await sql`
    CREATE TABLE IF NOT EXISTS source_replenishment_runs (
      id BIGSERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      platform_target INTEGER NOT NULL,
      raw_candidate_target INTEGER NOT NULL,
      platform_ready_before INTEGER NOT NULL,
      platform_ready_after INTEGER NOT NULL,
      raw_candidates_before INTEGER NOT NULL,
      raw_candidates_after INTEGER NOT NULL,
      continuous_snapshot_products INTEGER NOT NULL,
      steps JSONB NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`
    INSERT INTO source_replenishment_runs (
      mode,
      platform_target,
      raw_candidate_target,
      platform_ready_before,
      platform_ready_after,
      raw_candidates_before,
      raw_candidates_after,
      continuous_snapshot_products,
      steps,
      duration_ms
    )
    VALUES (
      ${result.mode},
      ${result.platformTarget},
      ${result.rawCandidateTarget},
      ${result.before.platformReady},
      ${result.after.platformReady},
      ${result.rawCandidatesBefore},
      ${result.rawCandidatesAfter},
      ${result.continuousSnapshotProducts},
      ${JSON.stringify(result.steps)}::jsonb,
      ${result.durationMs}
    )
  `.catch(() => {})
}

export async function getRecentReplenishmentRuns(limit = 5) {
  const rows = await queryRows<{
    id: string | number
    mode: string
    platform_target: string | number
    raw_candidate_target: string | number
    platform_ready_before: string | number
    platform_ready_after: string | number
    raw_candidates_before: string | number
    raw_candidates_after: string | number
    continuous_snapshot_products: string | number
    duration_ms: string | number
    created_at: string
  }>`
    SELECT id, mode, platform_target, raw_candidate_target,
           platform_ready_before, platform_ready_after,
           raw_candidates_before, raw_candidates_after,
           continuous_snapshot_products, duration_ms, created_at
    FROM source_replenishment_runs
    ORDER BY created_at DESC
    LIMIT ${clamp(Math.round(limit), 1, 20)}
  `.catch(() => [])

  return rows.map((row) => ({
    id: String(row.id),
    mode: row.mode,
    platformTarget: toNumber(row.platform_target),
    rawCandidateTarget: toNumber(row.raw_candidate_target),
    platformReadyBefore: toNumber(row.platform_ready_before),
    platformReadyAfter: toNumber(row.platform_ready_after),
    rawCandidatesBefore: toNumber(row.raw_candidates_before),
    rawCandidatesAfter: toNumber(row.raw_candidates_after),
    continuousSnapshotProducts: toNumber(row.continuous_snapshot_products),
    durationMs: toNumber(row.duration_ms),
    createdAt: row.created_at,
  }))
}

export async function runReadyQueueReplenishment(options: ReplenishmentOptions = {}): Promise<ReplenishmentRunResult> {
  const startedAt = Date.now()
  const platformTarget = clamp(Math.round(options.platformTarget ?? 300), 30, 3000)
  const rawCandidateTarget = clamp(Math.round(options.rawCandidateTarget ?? 5000), 300, 100_000)
  const maxRuntimeMs = clamp(Math.round(options.maxRuntimeMs ?? 240_000), 30_000, 290_000)
  const steps: ReplenishmentStep[] = []

  const before = await getSourceReadinessAudit()
  const rawBefore = await countRawCandidates()
  const settings = await getDiscoverySettings()

  if (!settings.enabled) {
    const result: ReplenishmentRunResult = {
      ok: true,
      mode: 'disabled',
      platformTarget,
      rawCandidateTarget,
      before,
      after: before,
      rawCandidatesBefore: rawBefore,
      rawCandidatesAfter: rawBefore,
      continuousSnapshotProducts: 0,
      steps: [{ step: 'settings', status: 'skipped', reason: 'graph_discovery_disabled' }],
      durationMs: Date.now() - startedAt,
    }
    await logRun(result)
    return result
  }

  const alreadyHealthy = before.platformReady >= platformTarget && rawBefore >= rawCandidateTarget
  if (alreadyHealthy && !options.force) {
    const snapshotProducts = await refreshContinuousReadySnapshot()
    const result: ReplenishmentRunResult = {
      ok: true,
      mode: 'healthy',
      platformTarget,
      rawCandidateTarget,
      before,
      after: before,
      rawCandidatesBefore: rawBefore,
      rawCandidatesAfter: rawBefore,
      continuousSnapshotProducts: snapshotProducts,
      steps: [{ step: 'snapshot', status: 'ran', metrics: { products: snapshotProducts } }],
      durationMs: Date.now() - startedAt,
    }
    await logRun(result)
    return result
  }

  if (options.dryRun) {
    const result: ReplenishmentRunResult = {
      ok: true,
      mode: 'dry-run',
      platformTarget,
      rawCandidateTarget,
      before,
      after: before,
      rawCandidatesBefore: rawBefore,
      rawCandidatesAfter: rawBefore,
      continuousSnapshotProducts: 0,
      steps: [{ step: 'plan', status: 'skipped', reason: 'dry_run' }],
      durationMs: Date.now() - startedAt,
    }
    await logRun(result)
    return result
  }

  let latestAudit = before
  let latestRaw = rawBefore

  if (latestRaw < rawCandidateTarget || latestAudit.platformReady < platformTarget || options.force) {
    const discoveryStarted = Date.now()
    const discoveryRuntime = Math.min(110_000, Math.max(30_000, maxRuntimeMs - (Date.now() - startedAt) - 90_000))
    if (discoveryRuntime > 25_000) {
      try {
        const discovery = await runGraphDiscovery({ maxRuntimeMs: discoveryRuntime })
        steps.push({ step: 'discovery', status: 'ran', metrics: discovery })
        latestRaw = await countRawCandidates()
      } catch (error) {
        steps.push({
          step: 'discovery',
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      steps.push({ step: 'discovery', status: 'skipped', reason: 'runtime_budget_low' })
    }
    if (Date.now() - discoveryStarted > discoveryRuntime + 5_000) {
      steps.push({ step: 'discovery-runtime', status: 'skipped', reason: 'discovery_exceeded_budget' })
    }
  }

  const quotaState = await getThrottleState('rapidapi').catch(() => 'ok' as const)
  if (quotaState !== 'ok') {
    steps.push({ step: 'enrichment', status: 'skipped', reason: `rapidapi_${quotaState}` })
  } else {
    const deficit = Math.max(0, platformTarget - latestAudit.platformReady)
    const baseBudget = settings.enrichmentBudget || 15
    const adaptiveBudget = options.force
      ? Math.max(baseBudget, 40)
      : deficit >= 200
        ? Math.max(baseBudget, 60)
        : deficit >= 75
          ? Math.max(baseBudget, 35)
          : baseBudget
    const budget = clamp(adaptiveBudget, 0, 100)

    if (budget <= 0) {
      steps.push({ step: 'enrichment', status: 'skipped', reason: 'budget_zero' })
    } else if (Date.now() - startedAt > maxRuntimeMs - 45_000) {
      steps.push({ step: 'enrichment', status: 'skipped', reason: 'runtime_budget_low' })
    } else {
      try {
        const enrichment = await enrichTopCandidates({
          budget,
          maxRuntimeMs: Math.min(90_000, Math.max(30_000, maxRuntimeMs - (Date.now() - startedAt) - 25_000)),
        })
        steps.push({ step: 'enrichment', status: 'ran', metrics: enrichment })
      } catch (error) {
        steps.push({
          step: 'enrichment',
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  // Pull fresh audit after enrichment. The audit is intentionally the controller's feedback loop:
  // if enrichment produces weak candidates, the next run sees the deficit and keeps sourcing.
  latestAudit = await getSourceReadinessAudit()
  latestRaw = await countRawCandidates()

  // Keep the legacy continuous cache warm for admin visibility and any older consumers. The
  // dashboard route now reads the source engine directly, but this snapshot makes the old
  // cache reflect the same ready-product pool instead of stale product_cache rows.
  let snapshotProducts = 0
  try {
    snapshotProducts = await refreshContinuousReadySnapshot()
    steps.push({ step: 'snapshot', status: 'ran', metrics: { products: snapshotProducts } })
  } catch (error) {
    steps.push({
      step: 'snapshot',
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  const result: ReplenishmentRunResult = {
    ok: true,
    mode: 'replenished',
    platformTarget,
    rawCandidateTarget,
    before,
    after: latestAudit,
    rawCandidatesBefore: rawBefore,
    rawCandidatesAfter: latestRaw,
    continuousSnapshotProducts: snapshotProducts,
    steps,
    durationMs: Date.now() - startedAt,
  }
  await logRun(result)
  return result
}

export async function getReplenishmentStatus() {
  const [audit, rawCandidates, breadth, recentRuns] = await Promise.all([
    getSourceReadinessAudit(),
    countRawCandidates(),
    getSourcingBreadthMetrics().catch(() => null),
    getRecentReplenishmentRuns(5),
  ])

  return {
    audit,
    rawCandidates,
    breadth,
    recentRuns,
  }
}
