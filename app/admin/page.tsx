'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type Customer = {
  id: number
  email: string
  name: string
  joined: string | null
  ebayConnected: boolean
  ebayUpdatedAt: string | null
  ebayTokenExpiresAt: string | null
  totalListings: number
  activeListings: number
  activeProfit: number
  lastListingAt: string | null
  activeRecently: boolean
}

type RecentListing = {
  id: number
  userId: number
  sellerName: string
  sellerEmail: string
  asin: string
  title: string
  ebayListingId: string
  listedAt: string | null
  amazonPrice: number
  ebayPrice: number
  niche: string
  categoryId: string
  imageCount: number
}

type ProblemListing = RecentListing & {
  categoryName: string
  cacheImageCount: number
  cacheUpdatedAt: string | null
  cacheAvailable: boolean | null
  issues: string[]
  repairHint: string
}

type SourceNiche = {
  name: string
  count: number
  averageScore: number
  maxScore: number
  newestSeenAt: string | null
}

type TrendingNiche = {
  name: string
  activeProducts: number
  cacheProducts: number
  readyProducts: number
  needsEnrichment: number
  averageProfit: number
  averageRoi: number
  averageScore: number
  latestSeenAt: string | null
  cacheRefreshedAt: string | null
  missingImages: number
  highRiskProducts: number
  status: 'ready' | 'watch' | 'low'
}

type SourceRecommendation = {
  niche: string
  healthScore: number
  readyProducts: number
  cacheProducts: number
  activeProducts: number
  staleProducts: number
  unavailableProducts: number
  failedQueue30d: number
  completedQueue30d: number
  averageProfit: number
  averageRoi: number
  learningMultiplier: number
  recommendedAction: string
  lastCacheAt: string | null
  updatedAt: string | null
}

type SourceRun = {
  id: string
  mode: string
  trigger: string
  status: string
  productsFound: number
  productsRejected: number
  readyToList: number
  durationMs: number
  createdAt: string | null
  error: string | null
}

type SourceAutopilot = {
  enabled: boolean
  available: boolean
  scheduledNow?: boolean
  nextRunAfter: string | null
  lastStartedAt: string | null
  lastReason: string | null
  lastNiches: string[]
  updatedAt: string | null
}

type SourceAgentRun = {
  id: string
  provider: string
  status: string
  plan: {
    newNiches?: Array<{ name: string; queries: string[]; reason?: string }>
    repairNiches?: string[]
    notes?: string[]
  }
  metrics: {
    createdNiches?: string[]
    repairNiches?: string[]
    cleanedProducts?: number
    refreshScheduled?: boolean
  }
  error: string | null
  durationMs: number
  createdAt: string | null
}

type SourceIntelligenceSummary = {
  status: 'healthy' | 'self-healing' | 'watch' | string
  lastRun: SourceRun | null
  runsToday: number
  productsFoundToday: number
  productsRejectedToday: number
  readyToListProducts: number
  weakNiches: number
  averageNicheHealth: number
  failedJobs24h: number
  autopilot: SourceAutopilot | null
  recentRuns: SourceRun[]
  recommendations: SourceRecommendation[]
}

type ManagedSourceNiche = {
  name: string
  queries: string[]
  active: boolean
  notes: string
  updatedAt: string | null
}

type NichePerformance = {
  niche: string
  listings: number
  sellers: number
  revenue: number
  profit: number
}

type AutomationSummary = {
  proCron: {
    sourceMaintenance: string
    nicheStock: string
    deepCatalog: string
    autoBulk: string
    listingAuditBatch: number
  }
  autoListing: {
    totalSettings: number
    enabledUsers: number
    runningUsers: number
    pausedUsers: number
    emergencyStoppedUsers: number
    queued: number
    retry: number
    processing: number
    failed: number
    dueNow: number
    readyQueue: number
    listed24h: number
    averageScore: number
    oldestDueAt: string | null
    nextDueAt: string | null
    latestListedAt: string | null
  }
  listingAudit: {
    activeListings: number
    markedUnavailable: number
    dueForAudit: number
    checked24h: number
    lastCheckedAt: string | null
  }
}

type Stats = {
  ok?: boolean
  generatedAt: string
  status: 'healthy' | 'watch' | 'attention'
  warnings: string[]
  totalUsers: number
  ebayConnected: number
  activeRecently: number
  customers: Customer[]
  listingSummary: {
    totalListings: number
    activeListings: number
    listed7Days: number
    listed30Days: number
    lowImageActive: number
    legacyUnaudited?: number
    imageBreakdown?: { oneImage: number; twoImages: number; threePlusImages: number; qualityWarnings: number }
    missingCategoryActive: number
    activeRevenue: number
    activeCost: number
    activeProfit: number
    averageRoi: number
  }
  sourceHealth: {
    sourceEngine: {
      totalProducts: number
      niches: number
      staleProducts: number
      missingImages: number
      highRiskProducts: number
      averageScore: number
      newestSeenAt: string | null
    }
    publishReadiness: {
      activePool: number
      viableCandidates: number
      enrichedReady: number
      publishReady: number
      needsEnrichment: number
      alreadyListed: number
      unavailable: number
      blockedQuality: number
      nichesWith30Ready: number
    }
    cache: {
      totalNiches: number
      readyNiches: number
      staleNiches: number
      totalProducts: number
    }
    continuous: {
      products: number
      version: number
      cachedAt: string | null
    }
    sourceAgent: {
      enabled: boolean
      provider: string
      recentRuns: SourceAgentRun[]
    }
    intelligence: SourceIntelligenceSummary | null
    topNiches: SourceNiche[]
    trendingNiches: TrendingNiche[]
    agentStatus?: {
      reprice: { last_run: string | null; runs_24h: number; revised_24h?: number } | null
      fulfillment: { last_run: string | null; runs_24h: number } | null
      digest: { last_run: string | null; runs_24h: number } | null
    }
  }
  automation?: AutomationSummary
  recentListings: RecentListing[]
  problemListings: ProblemListing[]
  nichePerformance: NichePerformance[]
}

type ToolState = {
  active: string | null
  tone: 'info' | 'success' | 'error'
  message: string
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(Math.round(value || 0))
}

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value || 0)
}

function formatDate(value: string | null) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDateTime(value: string | null) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function formatDuration(value: number) {
  if (!value) return '0s'
  const seconds = Math.max(1, Math.round(value / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
}

const EMPTY_AUTOMATION: AutomationSummary = {
  proCron: {
    sourceMaintenance: 'Every 30 minutes',
    nicheStock: 'Every hour',
    deepCatalog: 'Every 6 hours',
    autoBulk: 'Every 15 minutes',
    listingAuditBatch: 60,
  },
  autoListing: {
    totalSettings: 0,
    enabledUsers: 0,
    runningUsers: 0,
    pausedUsers: 0,
    emergencyStoppedUsers: 0,
    queued: 0,
    retry: 0,
    processing: 0,
    failed: 0,
    dueNow: 0,
    readyQueue: 0,
    listed24h: 0,
    averageScore: 0,
    oldestDueAt: null,
    nextDueAt: null,
    latestListedAt: null,
  },
  listingAudit: {
    activeListings: 0,
    markedUnavailable: 0,
    dueForAudit: 0,
    checked24h: 0,
    lastCheckedAt: null,
  },
}

function truncate(value: string, length = 58) {
  if (!value) return '-'
  return value.length > length ? `${value.slice(0, length - 1)}...` : value
}

async function readJson(res: Response) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error?.message || data?.message || `Request failed (${res.status})`)
  }
  return data
}

function usePoolRefresh(onDone: () => void) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [msg, setMsg] = useState('')

  const trigger = async (mode: 'catalog' | 'sourceOnly' | 'stockWeak') => {
    setState('running')
    setMsg(
      mode === 'catalog'
        ? 'Deep catalog crawl running. This can take a few minutes.'
        : mode === 'stockWeak'
          ? 'Stocking low-cache niches now.'
          : 'Quick refresh running.'
    )
    try {
      const res = await fetch('/api/admin/refresh-pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const data = await readJson(res)
      const result = data.result || {}
      setState('done')
      setMsg(
        `Done. ${result.nichesRefreshed ?? 0} niches refreshed, ${formatNumber(result.sourceProducts ?? 0)} products in source pool, ${formatNumber(result.continuousProducts ?? 0)} in continuous queue.`
      )
      onDone()
    } catch (error) {
      setState('error')
      setMsg(error instanceof Error ? error.message : 'Refresh failed.')
    }
  }

  const restockAll = async () => {
    setState('running')
    setMsg('Restocking ALL niches to max — running full sweep + deep catalog in background. Check back in 5 minutes.')
    try {
      const res = await fetch('/api/admin/restock-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await readJson(res)
      setState('done')
      setMsg(data.message || 'Restock triggered. All niche crawls are running in the background.')
      onDone()
    } catch (error) {
      setState('error')
      setMsg(error instanceof Error ? error.message : 'Restock failed.')
    }
  }

  return { state, msg, trigger, restockAll }
}

export default function AdminPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [stats, setStats] = useState<Stats | null>(null)
  const [collab, setCollab] = useState('')
  const [collabFileMtime, setCollabFileMtime] = useState<string | null>(null)
  const [collabGitSha, setCollabGitSha] = useState<string | null>(null)
  const [collabDeploymentId, setCollabDeploymentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toolState, setToolState] = useState<ToolState>({ active: null, tone: 'info', message: '' })
  const [sourceNiches, setSourceNiches] = useState<ManagedSourceNiche[]>([])
  const [nicheForm, setNicheForm] = useState({ name: '', queries: '', notes: '' })
  const [nicheAction, setNicheAction] = useState<string | null>(null)
  const [poolStatus, setPoolStatus] = useState<{ totalPool: number; totalAlreadyListed: number; totalTrulyValid: number; validByNiche: Array<{ niche: string | null; validCount: number }> } | null>(null)
  const [lowImageState, setLowImageState] = useState<'idle' | 'previewing' | 'confirm' | 'running' | 'done' | 'error'>('idle')
  const [lowImagePreview, setLowImagePreview] = useState<{ count: number; listings: Array<{ ebayListingId: string; asin: string; title: string }> } | null>(null)
  const [lowImageMsg, setLowImageMsg] = useState('')

  // Legacy image audit (image_count IS NULL — older listings)
  type AuditedListing = {
    id: number; userId: number; ebayListingId: string; asin: string; title: string
    listedAt: string | null; liveImageCount: number | null
    classification: '1-image' | '2-images' | '3+-images' | 'unverified'
    suggestedAction: string; ebayLink: string
  }
  type AuditResult = {
    total: number; capped: boolean; remainingLegacy: number
    listings: AuditedListing[]
    summary: { oneImage: number; twoImages: number; threePlus: number; unverified: number }
    message: string
  }
  const [legacyAuditState, setLegacyAuditState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [legacyAuditResult, setLegacyAuditResult] = useState<AuditResult | null>(null)
  const [legacyAuditMsg, setLegacyAuditMsg] = useState('')
  const [legacyEndState, setLegacyEndState] = useState<'idle' | 'confirm' | 'ending' | 'done' | 'error'>('idle')
  const [legacyEndMsg, setLegacyEndMsg] = useState('')

  const loadAdmin = useCallback(async () => {
    setError(null)
    const [statsRes, collabRes, sourceNicheRes, poolRes] = await Promise.all([
      fetch('/api/admin/stats').then(readJson),
      fetch(`/api/admin/collab?t=${Date.now()}`, { cache: 'no-store' }).then(readJson),
      fetch('/api/admin/source-niches').then(readJson),
      fetch('/api/debug/pool-status').then(readJson).catch(() => null),
    ])
    setPoolStatus(poolRes as typeof poolStatus)

    setStats(statsRes as Stats)
    setSourceNiches(Array.isArray(sourceNicheRes?.customNiches) ? sourceNicheRes.customNiches : [])
    setCollab(String(collabRes?.content || ''))
    setCollabFileMtime(
      typeof collabRes?.fileMtime === 'string' && collabRes.fileMtime ? collabRes.fileMtime : null
    )
    setCollabGitSha(typeof collabRes?.gitSha === 'string' && collabRes.gitSha ? collabRes.gitSha : null)
    setCollabDeploymentId(
      typeof collabRes?.deploymentId === 'string' && collabRes.deploymentId ? collabRes.deploymentId : null
    )
  }, [])

  const pool = usePoolRefresh(() => {
    loadAdmin().catch(() => {})
  })

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login')
      return
    }
    if (status !== 'authenticated') return

    setLoading(true)
    loadAdmin()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load admin dashboard.'))
      .finally(() => setLoading(false))
  }, [loadAdmin, router, status])

  const statusCopy = useMemo(() => {
    if (!stats) return { label: 'Loading', detail: 'Checking launch status.' }
    if (stats.status === 'healthy') return { label: 'Healthy', detail: 'Core launch systems look ready.' }
    if (stats.status === 'watch') return { label: 'Watch', detail: 'A few items need monitoring before launch.' }
    return { label: 'Attention', detail: 'Fix the highlighted items before wider launch.' }
  }, [stats])

  const runTool = async (id: string, label: string, url: string, method: 'GET' | 'POST' = 'GET') => {
    setToolState({ active: id, tone: 'info', message: `${label} running...` })
    try {
      const data = await readJson(await fetch(url, { method }))
      setToolState({
        active: null,
        tone: 'success',
        message: data.message || data.result?.message || `${label} completed.`,
      })
      await loadAdmin()
    } catch (err) {
      setToolState({
        active: null,
        tone: 'error',
        message: err instanceof Error ? err.message : `${label} failed.`,
      })
    }
  }

  const previewLowImageListings = async () => {
    setLowImageState('previewing')
    setLowImageMsg('Checking for 1-image listings...')
    try {
      const data = await readJson(await fetch('/api/admin/end-low-image-listings'))
      setLowImagePreview({ count: data.count ?? 0, listings: data.listings ?? [] })
      setLowImageMsg(data.message || '')
      setLowImageState(data.count > 0 ? 'confirm' : 'done')
    } catch (err) {
      setLowImageState('error')
      setLowImageMsg(err instanceof Error ? err.message : 'Preview failed.')
    }
  }

  const confirmEndLowImageListings = async () => {
    setLowImageState('running')
    setLowImageMsg(`Ending ${lowImagePreview?.count ?? 0} listings on eBay...`)
    try {
      const data = await readJson(await fetch('/api/admin/end-low-image-listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      }))
      setLowImageMsg(data.message || 'Done.')
      setLowImageState('done')
      await loadAdmin()
    } catch (err) {
      setLowImageState('error')
      setLowImageMsg(err instanceof Error ? err.message : 'Failed to end listings.')
    }
  }

  const runLegacyAudit = async () => {
    setLegacyAuditState('running')
    setLegacyAuditMsg('Fetching live image counts from eBay — this can take up to 60 seconds for large accounts...')
    setLegacyAuditResult(null)
    setLegacyEndState('idle')
    setLegacyEndMsg('')
    try {
      const data = await readJson(await fetch('/api/admin/audit-legacy-images'))
      setLegacyAuditResult(data as Parameters<typeof setLegacyAuditResult>[0])
      setLegacyAuditMsg(data.message || '')
      setLegacyAuditState('done')
    } catch (err) {
      setLegacyAuditState('error')
      setLegacyAuditMsg(err instanceof Error ? err.message : 'Audit failed.')
    }
  }

  const confirmEndLegacyListings = async (ids: number[]) => {
    setLegacyEndState('ending')
    setLegacyEndMsg(`Ending ${ids.length} listing${ids.length !== 1 ? 's' : ''} on eBay...`)
    try {
      const data = await readJson(await fetch('/api/admin/audit-legacy-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true, ids }),
      }))
      setLegacyEndMsg(data.message || 'Done.')
      setLegacyEndState('done')
      // Re-run audit to reflect the ended listings
      await runLegacyAudit()
    } catch (err) {
      setLegacyEndState('error')
      setLegacyEndMsg(err instanceof Error ? err.message : 'Failed to end listings.')
    }
  }

  const refreshNiche = async (name: string) => {
    setNicheAction(`refresh:${name}`)
    setToolState({ active: null, tone: 'info', message: `Refreshing ${name} source products...` })
    try {
      const data = await readJson(await fetch('/api/admin/refresh-pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'stockWeak', niche: name }),
      }))
      const attempted = Array.isArray(data?.result?.nichesAttempted) ? data.result.nichesAttempted.join(', ') : name
      setToolState({
        active: null,
        tone: 'success',
        message: `Stock refresh completed for ${attempted}. Source pool now has ${formatNumber(data?.result?.sourceProducts ?? 0)} products.`,
      })
      await loadAdmin()
    } catch (err) {
      setToolState({
        active: null,
        tone: 'error',
        message: err instanceof Error ? err.message : `Could not refresh ${name}.`,
      })
    } finally {
      setNicheAction(null)
    }
  }

  const saveSourceNiche = async () => {
    setNicheAction('save')
    try {
      await readJson(await fetch('/api/admin/source-niches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nicheForm),
      }))
      setNicheForm({ name: '', queries: '', notes: '' })
      setToolState({ active: null, tone: 'success', message: 'Source niche saved. Run a niche refresh to stock it now.' })
      await loadAdmin()
    } catch (err) {
      setToolState({ active: null, tone: 'error', message: err instanceof Error ? err.message : 'Could not save source niche.' })
    } finally {
      setNicheAction(null)
    }
  }

  const editSourceNiche = (niche: ManagedSourceNiche) => {
    setNicheForm({
      name: niche.name,
      queries: niche.queries.join('\n'),
      notes: niche.notes,
    })
  }

  const setSourceNicheActive = async (name: string, active: boolean) => {
    setNicheAction(`toggle:${name}`)
    try {
      await readJson(await fetch('/api/admin/source-niches', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, active }),
      }))
      setToolState({ active: null, tone: 'success', message: `${name} ${active ? 'enabled' : 'disabled'} for future source crawls.` })
      await loadAdmin()
    } catch (err) {
      setToolState({ active: null, tone: 'error', message: err instanceof Error ? err.message : 'Could not update source niche.' })
    } finally {
      setNicheAction(null)
    }
  }

  if (loading) {
    return (
      <div className="admin-loading">
        Loading StackPilot Admin...
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="admin-loading admin-loading-error">
        {error || 'Access denied.'}
      </div>
    )
  }

  const listingSummary = stats.listingSummary
  const source = stats.sourceHealth.sourceEngine
  const publishReadiness = stats.sourceHealth.publishReadiness
  const cache = stats.sourceHealth.cache
  const continuous = stats.sourceHealth.continuous
  const intelligence = stats.sourceHealth.intelligence
  const sourceAgent = stats.sourceHealth.sourceAgent
  const autopilot = intelligence?.autopilot
  const automation = stats.automation ?? EMPTY_AUTOMATION

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <Link href="/" className="home-brand" aria-label="StackPilot home">
          Stack<span>Pilot</span>
        </Link>
        <div className="admin-topbar-actions">
          <span>{session?.user?.email}</span>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-hero">
          <div>
            <div className="admin-kicker">Admin Control Center</div>
            <h1>Launch operations</h1>
            <p>
              The admin page now shows account health, listing health, product pool depth,
              continuous queue readiness, recent listings, and the tools you need to keep StackPilot stable.
            </p>
          </div>
          <div className={`admin-status-card admin-status-${stats.status}`}>
            <span>System status</span>
            <strong>{statusCopy.label}</strong>
            <p>{statusCopy.detail}</p>
            <small>Updated {formatDateTime(stats.generatedAt)}</small>
          </div>
        </div>

        <div className="admin-metrics-grid">
          <MetricCard label="Accounts" value={formatNumber(stats.totalUsers)} detail={`${stats.ebayConnected} eBay connected`} />
          <MetricCard label="Active Listings" value={formatNumber(listingSummary.activeListings)} detail={`${formatNumber(listingSummary.listed30Days)} listed in 30 days`} />
          <MetricCard label="Active Profit" value={formatMoney(listingSummary.activeProfit)} detail={`${Math.round(listingSummary.averageRoi || 0)}% average ROI`} />
          <MetricCard label="Publish-Ready Now" value={formatNumber(publishReadiness.publishReady)} detail={`${publishReadiness.nichesWith30Ready} niches have 30+ ready`} />
          <MetricCard label="Source Candidates" value={formatNumber(source.totalProducts)} detail={`${formatNumber(publishReadiness.needsEnrichment)} need enrichment`} />
          <MetricCard label="Continuous Queue" value={formatNumber(continuous.products)} detail={`Version ${continuous.version || 0}`} />
          <MetricCard label="Niche Caches" value={`${cache.readyNiches}/${cache.totalNiches}`} detail={`${cache.staleNiches} stale caches`} />
        </div>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Product publishing funnel</span>
              <h2>Exactly what can be published right now</h2>
            </div>
            <span className={`admin-pill admin-pill-${publishReadiness.publishReady >= 900 ? 'good' : publishReadiness.publishReady >= 300 ? 'watch' : 'bad'}`}>
              {formatNumber(publishReadiness.publishReady)} ready
            </span>
          </div>
          <div className="admin-health-grid">
            <SmallStat label="Active source rows" value={formatNumber(publishReadiness.activePool || source.totalProducts)} />
            <SmallStat label="Pass price/risk" value={formatNumber(publishReadiness.viableCandidates)} />
            <SmallStat label="Enriched 2+ images" value={formatNumber(publishReadiness.enrichedReady)} />
            <SmallStat label="Publish-ready" value={formatNumber(publishReadiness.publishReady)} tone={publishReadiness.publishReady < 300 ? 'warn' : undefined} />
            <SmallStat label="Need enrichment" value={formatNumber(publishReadiness.needsEnrichment)} />
            <SmallStat label="Already listed" value={formatNumber(publishReadiness.alreadyListed)} />
            <SmallStat label="Unavailable" value={formatNumber(publishReadiness.unavailable)} />
            <SmallStat label="Blocked quality" value={formatNumber(publishReadiness.blockedQuality)} />
          </div>
          <div className="admin-subtle-line">
            Publish-ready means: active source row, profit at least $4, ROI at least 25%, not high risk, Amazon cache not unavailable, cached Amazon product exists with 2+ images, and the ASIN is not already active on StackPilot.
          </div>
          <div className="admin-table-wrap" style={{ marginTop: '14px' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Niche</th>
                  <th>Publish-ready</th>
                  <th>Need enrichment</th>
                  <th>Active candidates</th>
                  <th>Cache</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {stats.sourceHealth.trendingNiches
                  .slice()
                  .sort((a, b) => b.readyProducts - a.readyProducts || b.activeProducts - a.activeProducts)
                  .slice(0, 18)
                  .map((niche) => (
                    <tr key={niche.name}>
                      <td>{niche.name}</td>
                      <td><strong>{formatNumber(niche.readyProducts)}</strong></td>
                      <td>{formatNumber(niche.needsEnrichment)}</td>
                      <td>{formatNumber(niche.activeProducts)}</td>
                      <td>{formatNumber(niche.cacheProducts)}</td>
                      <td>
                        <span className={`admin-pill admin-pill-${niche.readyProducts >= 30 ? 'good' : niche.readyProducts >= 10 ? 'watch' : 'bad'}`}>
                          {niche.readyProducts >= 30 ? 'Ready' : niche.readyProducts >= 10 ? 'Thin' : 'Needs work'}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-panel admin-automation-panel">
          <div className="admin-panel-head">
            <div>
              <span>Automation command center</span>
              <h2>What is running automatically</h2>
            </div>
            <span className={`admin-pill admin-pill-${automation.autoListing.runningUsers > 0 ? 'good' : automation.autoListing.enabledUsers > 0 ? 'watch' : 'neutral'}`}>
              {automation.autoListing.runningUsers > 0 ? 'Live' : automation.autoListing.enabledUsers > 0 ? 'Paused' : 'Manual'}
            </span>
          </div>
          <div className="admin-automation-grid">
            <div>
              <span>Source maintenance</span>
              <strong>{automation.proCron.sourceMaintenance}</strong>
              <p>Reprices products, refreshes availability signals, cleans bad source rows, and audits active Amazon status.</p>
            </div>
            <div>
              <span>Niche stocker</span>
              <strong>{automation.proCron.nicheStock}</strong>
              <p>Targets caches marked Needs stock and refills them from fresh Amazon search results.</p>
            </div>
            <div>
              <span>Deep catalog crawl</span>
              <strong>{automation.proCron.deepCatalog}</strong>
              <p>Runs the heavier catalog sweep so the long-term source pool stays deep and fresh.</p>
            </div>
            <div>
              <span>Auto Bulk Listing</span>
              <strong>{automation.proCron.autoBulk}</strong>
              <p>Rotates through enabled users and respects pause, emergency stop, max/hour, cooldown, and queue readiness.</p>
            </div>
            <div>
              <span>Active listing audit</span>
              <strong>{automation.proCron.listingAuditBatch}/run</strong>
              <p>Checks live listings against Amazon availability and marks unavailable products for removal.</p>
            </div>
          </div>
          <div className="admin-health-grid">
            <SmallStat label="Auto Bulk users" value={`${automation.autoListing.runningUsers}/${automation.autoListing.enabledUsers}`} />
            <SmallStat label="Ready queue" value={formatNumber(automation.autoListing.readyQueue)} />
            <SmallStat label="Due now" value={formatNumber(automation.autoListing.dueNow)} />
            <SmallStat label="Listed 24h" value={formatNumber(automation.autoListing.listed24h)} />
            <SmallStat label="Queue score" value={automation.autoListing.averageScore ? automation.autoListing.averageScore.toFixed(1) : '0'} />
            <SmallStat label="Failed queue" value={formatNumber(automation.autoListing.failed)} />
            <SmallStat label="Audit due" value={formatNumber(automation.listingAudit.dueForAudit)} />
            <SmallStat label="Unavailable" value={formatNumber(automation.listingAudit.markedUnavailable)} />
          </div>
          <div className="admin-automation-notes">
            <div>
              <strong>Next Auto Bulk job</strong>
              <span>{formatDateTime(automation.autoListing.nextDueAt || automation.autoListing.oldestDueAt)}</span>
            </div>
            <div>
              <strong>Last Auto Bulk listing</strong>
              <span>{formatDateTime(automation.autoListing.latestListedAt)}</span>
            </div>
            <div>
              <strong>Last Amazon audit</strong>
              <span>{formatDateTime(automation.listingAudit.lastCheckedAt)}</span>
            </div>
          </div>
          <div className="admin-subtle-line">
            This is the launch safety view: clients can use the dashboard normally while these background jobs keep product pools stocked, queues rotating, and stale Amazon listings under review.
          </div>
        </section>

        {/* 24/7 Agent Status */}
        <section className="admin-panel" style={{ marginBottom: '20px' }}>
          <div className="admin-panel-head">
            <div>
              <span>24/7 Agents</span>
              <h2>Always-running backend agents</h2>
            </div>
            <span className="admin-pill admin-pill-good">All Active</span>
          </div>
          <div className="admin-automation-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px', marginTop: '12px' }}>
            {[
              { label: 'Pool Maintenance', freq: 'Every 15 min', desc: 'Sync eBay, reprice pool' },
              { label: 'Stock Weak Niches', freq: 'Every 20 min ×10', desc: 'All 35 niches in ~70 min' },
              { label: 'Background Catalog', freq: 'Every hour ×4', desc: 'Deep 780-product stock' },
              { label: 'Full Sweep', freq: 'Every 8 hours', desc: 'Baseline all niches to 200' },
              { label: 'Auto-Listing', freq: 'Every 10 min', desc: 'Posts to eBay for all users' },
              { label: 'AI Source Agent', freq: 'Every hour', desc: 'Discover & repair niches' },
              { label: 'Reprice Agent', freq: 'Every hour', lastRun: stats.sourceHealth.agentStatus?.reprice?.last_run, runs24h: stats.sourceHealth.agentStatus?.reprice?.runs_24h },
              { label: 'Fulfillment Agent', freq: 'Every 10 min', lastRun: stats.sourceHealth.agentStatus?.fulfillment?.last_run, runs24h: stats.sourceHealth.agentStatus?.fulfillment?.runs_24h },
              { label: 'Daily Digest', freq: 'Daily 6 AM UTC', lastRun: stats.sourceHealth.agentStatus?.digest?.last_run, runs24h: stats.sourceHealth.agentStatus?.digest?.runs_24h },
            ].map((agent) => (
              <div key={agent.label} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '8px', padding: '10px 12px', borderLeft: '3px solid #4ade80' }}>
                <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '2px' }}>{agent.label}</div>
                <div style={{ color: 'var(--gold)', fontSize: '12px', marginBottom: '2px' }}>{agent.freq}</div>
                {agent.desc && <div style={{ color: 'var(--muted)', fontSize: '11px' }}>{agent.desc}</div>}
                {agent.lastRun && <div style={{ color: 'var(--muted)', fontSize: '11px' }}>Last: {formatDateTime(agent.lastRun)}</div>}
                {agent.runs24h !== undefined && <div style={{ color: 'var(--muted)', fontSize: '11px' }}>{agent.runs24h} runs today</div>}
              </div>
            ))}
          </div>
        </section>

        <section className="admin-grid admin-grid-2">
          <div className="admin-panel">
            <div className="admin-panel-head">
              <div>
                <span>Source intelligence</span>
                <h2>Always-on product engine</h2>
              </div>
              <span className={`admin-pill admin-pill-${intelligence?.status === 'healthy' ? 'good' : intelligence?.status === 'self-healing' ? 'watch' : 'bad'}`}>
                {intelligence?.status ? intelligence.status.replace('-', ' ') : 'No data'}
              </span>
            </div>
            <div className="admin-health-grid">
              <SmallStat label="New products today" value={formatNumber(intelligence?.productsFoundToday || 0)} />
              <SmallStat label="Cleaned today" value={formatNumber(intelligence?.productsRejectedToday || 0)} />
              <SmallStat label="Publish-ready now" value={formatNumber(publishReadiness.publishReady)} />
              <SmallStat label="Avg niche health" value={`${Math.round(intelligence?.averageNicheHealth || 0)}%`} />
            </div>
            <div className="admin-source-intel-row">
              <div>
                <strong>Last maintenance run</strong>
                <span>{formatDateTime(intelligence?.lastRun?.createdAt || null)}</span>
              </div>
              <div>
                <strong>Runs today</strong>
                <span>{formatNumber(intelligence?.runsToday || 0)}</span>
              </div>
              <div>
                <strong>Weak niches</strong>
                <span>{formatNumber(intelligence?.weakNiches || 0)}</span>
              </div>
              <div>
                <strong>Failed jobs</strong>
                <span>{formatNumber(intelligence?.failedJobs24h || 0)}</span>
              </div>
            </div>
            <div className="admin-subtle-line">
              New products today counts brand-new source rows first seen today. Publish-ready now is the stricter live count after image enrichment, availability, quality, and already-listed filters. Cleaned today means unavailable, weak, or failed-source items removed from active use.
            </div>
            <div className={`admin-autopilot-card ${autopilot?.scheduledNow ? 'is-running' : autopilot?.available ? 'is-ready' : 'is-cooling'}`}>
              <div>
                <span>Autopilot</span>
                <strong>
                  {autopilot?.scheduledNow
                    ? 'Repair running in background'
                    : autopilot?.available
                      ? 'Standing by'
                      : 'Cooling down safely'}
                </strong>
                <p>
                  {autopilot?.lastReason || 'Watches weak niches, stale queues, and source freshness automatically.'}
                </p>
              </div>
              <div>
                <small>Last started {formatDateTime(autopilot?.lastStartedAt || null)}</small>
                <small>Next allowed {autopilot?.available ? 'Now' : formatDateTime(autopilot?.nextRunAfter || null)}</small>
                {autopilot?.lastNiches?.length ? <small>Target: {autopilot.lastNiches.join(', ')}</small> : null}
              </div>
            </div>
            <div className="admin-autopilot-card is-ready">
              <div>
                <span>Source Agent</span>
                <strong>{sourceAgent?.provider === 'anthropic' ? 'Claude sourcing brain' : sourceAgent?.provider === 'openrouter' ? 'AI sourcing brain' : 'Rule-based sourcing brain'}</strong>
                <p>
                  Creates safe source niches, refreshes weak pools, and rejects bad source rows. It cannot publish listings.
                </p>
              </div>
              <div>
                <small>Runs every 2 hours</small>
                <small>Last run {formatDateTime(sourceAgent?.recentRuns?.[0]?.createdAt || null)}</small>
                <small>Cleaned {formatNumber(sourceAgent?.recentRuns?.[0]?.metrics?.cleanedProducts || 0)} products</small>
              </div>
            </div>
          </div>

          <div className="admin-panel">
            <div className="admin-panel-head">
              <div>
                <span>Recommended actions</span>
                <h2>What to fix next</h2>
              </div>
            </div>
            {!intelligence?.recommendations?.length ? (
              <div className="admin-empty">No source-engine recommendations yet.</div>
            ) : (
              <div className="admin-action-list">
                {intelligence.recommendations.slice(0, 5).map((item) => (
                  <div key={item.niche}>
                    <div>
                      <strong>{item.niche}</strong>
                      <span>{item.recommendedAction}</span>
                    </div>
                    <em>{Math.round(item.healthScore)}%</em>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="admin-grid admin-grid-2">
          <div className="admin-panel">
            <div className="admin-panel-head">
              <div>
                <span>Launch warnings</span>
                <h2>What needs attention</h2>
              </div>
            </div>
            {stats.warnings.length === 0 ? (
              <div className="admin-empty">No current launch warnings.</div>
            ) : (
              <div className="admin-warning-list">
                {stats.warnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            )}
            <div className="admin-warning-actions">
              <button
                className="btn btn-solid btn-sm"
                disabled={toolState.active !== null}
                onClick={() => runTool('repair-listings', 'Fix All listing warnings', '/api/admin/repair-listings', 'POST')}
              >
                {toolState.active === 'repair-listings' ? 'Fixing...' : 'Fix All'}
              </button>
              <span>Repairs stored listing images and category data across every account.</span>
            </div>
          </div>

          <div className="admin-panel">
            <div className="admin-panel-head">
              <div>
                <span>Admin tools</span>
                <h2>Actions</h2>
              </div>
            </div>
            <div className="admin-tool-grid">
              <button className="admin-tool" disabled={pool.state === 'running'} onClick={() => pool.trigger('sourceOnly')}>
                <strong>Quick Refresh</strong>
                <span>Reprice, enrich, and rebuild ready queues.</span>
              </button>
              <button className="admin-tool" disabled={pool.state === 'running'} onClick={() => pool.trigger('stockWeak')}>
                <strong>Stock Weak Niches</strong>
                <span>Refill low or stale niche caches without running a full deep crawl.</span>
              </button>
              <button className="admin-tool" disabled={pool.state === 'running'} onClick={() => pool.trigger('catalog')}>
                <strong>Deep Catalog Crawl</strong>
                <span>Heavy on-demand crawl. Autopilot now repairs weak niches automatically; this is only for manual force-refresh.</span>
              </button>
              <button className="admin-tool" style={{ borderColor: '#4ade80', background: 'rgba(74,222,128,0.06)' }} disabled={pool.state === 'running'} onClick={() => pool.restockAll()}>
                <strong>🚀 Restock All Niches</strong>
                <span>Fires all 4 crawl modes at once — brings every niche to max products immediately. Runs in background (~5 min).</span>
              </button>
              <button className="admin-tool" disabled={toolState.active !== null} onClick={() => runTool('setup', 'Database setup', '/api/setup-db')}>
                <strong>Repair Database</strong>
                <span>Ensure required tables and columns exist.</span>
              </button>
              <button className="admin-tool" disabled={toolState.active !== null} onClick={() => runTool('audit', 'Listing audit', '/api/scripts/run?script=listing-audit.js')}>
                <strong>Listing Audit</strong>
                <span>Check your active listings for local quality issues.</span>
              </button>
              <button className="admin-tool" disabled={toolState.active !== null} onClick={() => runTool('orders', 'Order check', '/api/scripts/run?script=check-orders.js')}>
                <strong>Check Orders</strong>
                <span>Check eBay orders needing shipment.</span>
              </button>
              <Link className="admin-tool" href="/dashboard">
                <strong>Open Dashboard</strong>
                <span>Jump back into the main app.</span>
              </Link>
            </div>
            {(pool.msg || toolState.message) && (
              <div className={`admin-tool-message admin-tool-${pool.state === 'error' || toolState.tone === 'error' ? 'error' : pool.state === 'done' || toolState.tone === 'success' ? 'success' : 'info'}`}>
                {pool.msg || toolState.message}
              </div>
            )}
          </div>
        </section>

        <section className="admin-grid admin-grid-2">
          <div className="admin-panel">
            <div className="admin-panel-head">
              <div>
                <span>Product source health</span>
                <h2>Pool readiness</h2>
              </div>
            </div>
            <div className="admin-health-grid">
              <SmallStat label="Publish-ready" value={formatNumber(publishReadiness.publishReady)} />
              <SmallStat label="Need enrichment" value={formatNumber(publishReadiness.needsEnrichment)} />
              <SmallStat label="Average score" value={source.averageScore.toFixed(1)} />
              <SmallStat label="Stale products" value={formatNumber(source.staleProducts)} />
              <SmallStat label="Missing images" value={formatNumber(source.missingImages)} />
              <SmallStat label="High risk" value={formatNumber(source.highRiskProducts)} />
            </div>
            <div className="admin-subtle-line">
              Newest product seen {formatDateTime(source.newestSeenAt)}. Continuous queue cached {formatDateTime(continuous.cachedAt)}.
            </div>
          </div>

          <div className="admin-panel">
            <div className="admin-panel-head">
              <div>
                <span>Listing quality</span>
                <h2>Stored listing checks</h2>
              </div>
            </div>
            <div className="admin-health-grid">
              <SmallStat label="Total listed" value={formatNumber(listingSummary.totalListings)} />
              <SmallStat label="Listed 7 days" value={formatNumber(listingSummary.listed7Days)} />
              <SmallStat label="Low-image active" value={formatNumber(listingSummary.lowImageActive)} tone={listingSummary.lowImageActive > 0 ? 'warn' : undefined} />
              <SmallStat label="Missing category" value={formatNumber(listingSummary.missingCategoryActive)} />
            </div>
            {listingSummary.imageBreakdown && (
              <div style={{ marginTop: '12px', padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Image quality — active listings</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--red)' }}>{formatNumber(listingSummary.imageBreakdown.oneImage)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--muted)' }}>1 image ⚠</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--gold)' }}>{formatNumber(listingSummary.imageBreakdown.twoImages)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--muted)' }}>2 images</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--green)' }}>{formatNumber(listingSummary.imageBreakdown.threePlusImages)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--muted)' }}>3+ images ✓</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 800, color: listingSummary.imageBreakdown.qualityWarnings > 0 ? 'var(--red)' : 'var(--green)' }}>{formatNumber(listingSummary.imageBreakdown.qualityWarnings)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--muted)' }}>quality flags</div>
                  </div>
                </div>
              </div>
            )}
            {/* End confirmed 1-image listings */}
            {(listingSummary.imageBreakdown?.oneImage ?? 0) > 0 && (
              <div style={{ marginTop: '14px', padding: '12px 14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px' }}>
                <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '4px', color: 'var(--red)' }}>
                  {formatNumber(listingSummary.imageBreakdown!.oneImage)} confirmed 1-image listing{listingSummary.imageBreakdown!.oneImage !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--muted)', marginBottom: '10px' }}>
                  These listings have a verified image count of 1. End them on eBay so the pool can relist with 2+ images.
                </div>

                {lowImageState === 'idle' && (
                  <button className="btn btn-solid btn-sm" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} onClick={previewLowImageListings}>
                    Preview &amp; end 1-image listings
                  </button>
                )}
                {lowImageState === 'previewing' && (
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Checking eBay...</div>
                )}
                {lowImageState === 'confirm' && lowImagePreview && (
                  <div>
                    <div style={{ fontSize: '12px', marginBottom: '8px' }}>
                      <strong style={{ color: 'var(--red)' }}>{lowImagePreview.count} listing{lowImagePreview.count !== 1 ? 's' : ''} will be ended on eBay.</strong>
                      {' '}This cannot be undone — they will be removed from your eBay store immediately.
                    </div>
                    {lowImagePreview.listings.length > 0 && (
                      <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '10px', maxHeight: '100px', overflowY: 'auto' }}>
                        {lowImagePreview.listings.map((l) => (
                          <div key={l.ebayListingId} style={{ marginBottom: '2px' }}>
                            {l.title.length > 60 ? `${l.title.slice(0, 57)}...` : l.title}
                            {' '}
                            <a href={`https://www.ebay.com/itm/${l.ebayListingId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>↗</a>
                          </div>
                        ))}
                        {lowImagePreview.count > lowImagePreview.listings.length && (
                          <div style={{ color: 'var(--muted)', fontStyle: 'italic' }}>...and {lowImagePreview.count - lowImagePreview.listings.length} more</div>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button className="btn btn-solid btn-sm" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} onClick={confirmEndLowImageListings}>
                        Yes — end {lowImagePreview.count} listing{lowImagePreview.count !== 1 ? 's' : ''} on eBay
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => { setLowImageState('idle'); setLowImagePreview(null); setLowImageMsg('') }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {lowImageState === 'running' && (
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>Ending listings on eBay... this may take a minute.</div>
                )}
                {(lowImageState === 'done' || lowImageState === 'error') && lowImageMsg && (
                  <div style={{ fontSize: '12px', color: lowImageState === 'error' ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{lowImageMsg}</div>
                )}
              </div>
            )}
            {/* Legacy unaudited notice */}
            {(listingSummary.legacyUnaudited ?? 0) > 0 && (
              <div style={{ marginTop: '12px', padding: '10px 14px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '20px', fontWeight: 800, color: 'var(--gold)', minWidth: '32px' }}>{formatNumber(listingSummary.legacyUnaudited ?? 0)}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--gold)' }}>listing{(listingSummary.legacyUnaudited ?? 0) !== 1 ? 's' : ''} without a recorded image count</div>
                  <div style={{ fontSize: '11px', color: 'var(--muted)' }}>These were listed before image tracking was deployed. Run the Legacy Image Audit below to classify them.</div>
                </div>
              </div>
            )}
            <div className="admin-subtle-line" style={{ marginTop: '10px' }}>
              Active revenue {formatMoney(listingSummary.activeRevenue)} against {formatMoney(listingSummary.activeCost)} stored cost basis.
            </div>
          </div>
        </section>

        {/* Legacy image audit — listings created before image_count tracking */}
        <section className="admin-panel" style={{ marginBottom: '20px' }}>
          <div className="admin-panel-head">
            <div>
              <span>Legacy image audit</span>
              <h2>Verify image counts on older listings</h2>
            </div>
            <span className={`admin-pill admin-pill-${legacyAuditState === 'done' ? 'good' : legacyAuditState === 'error' ? 'bad' : 'neutral'}`}>
              {legacyAuditState === 'idle' ? 'Not run' : legacyAuditState === 'running' ? 'Running…' : legacyAuditState === 'done' ? 'Complete' : 'Error'}
            </span>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--muted)', margin: '0 0 14px' }}>
            Listings created before the image-quality system was deployed have <code>image_count = NULL</code>.
            This audit fetches each listing&apos;s live image count directly from eBay, classifies it,
            and writes the count back to the database. Nothing is ended unless you explicitly confirm.
          </p>

          {legacyAuditState === 'idle' && (
            <button className="btn btn-solid btn-sm" onClick={runLegacyAudit}>
              Run legacy image audit
            </button>
          )}
          {legacyAuditState === 'running' && (
            <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{legacyAuditMsg}</div>
          )}
          {legacyAuditState === 'error' && (
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', color: 'var(--red)' }}>{legacyAuditMsg}</span>
              <button className="btn btn-ghost btn-sm" onClick={runLegacyAudit}>Retry</button>
            </div>
          )}

          {legacyAuditState === 'done' && legacyAuditResult && (
            <div>
              {/* Summary chips */}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
                <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, background: 'rgba(239,68,68,0.12)', color: 'var(--red)' }}>
                  {legacyAuditResult.summary.oneImage} × 1 image ⚠
                </span>
                <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, background: 'rgba(234,179,8,0.12)', color: 'var(--gold)' }}>
                  {legacyAuditResult.summary.twoImages} × 2 images
                </span>
                <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, background: 'rgba(74,222,128,0.12)', color: 'var(--green)' }}>
                  {legacyAuditResult.summary.threePlus} × 3+ images ✓
                </span>
                <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, background: 'rgba(255,255,255,0.06)', color: 'var(--muted)' }}>
                  {legacyAuditResult.summary.unverified} unverified
                </span>
                {legacyAuditResult.capped && (
                  <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', background: 'rgba(255,255,255,0.04)', color: 'var(--muted)' }}>
                    Capped at 200 — {legacyAuditResult.remainingLegacy} legacy listings remain. Run again to continue.
                  </span>
                )}
              </div>

              {/* End 1-image button */}
              {legacyAuditResult.summary.oneImage > 0 && (
                <div style={{ marginBottom: '16px', padding: '12px 14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px' }}>
                  {legacyEndState === 'idle' && (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--red)', marginBottom: '6px' }}>
                        {legacyAuditResult.summary.oneImage} legacy listing{legacyAuditResult.summary.oneImage !== 1 ? 's' : ''} confirmed with only 1 image
                      </div>
                      <button
                        className="btn btn-solid btn-sm"
                        style={{ background: 'var(--red)', borderColor: 'var(--red)' }}
                        onClick={() => setLegacyEndState('confirm')}
                      >
                        Review &amp; end these {legacyAuditResult.summary.oneImage} listing{legacyAuditResult.summary.oneImage !== 1 ? 's' : ''}
                      </button>
                    </div>
                  )}
                  {legacyEndState === 'confirm' && (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--red)', marginBottom: '6px' }}>
                        Confirm: end {legacyAuditResult.summary.oneImage} 1-image listing{legacyAuditResult.summary.oneImage !== 1 ? 's' : ''} on eBay — this cannot be undone
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--muted)', marginBottom: '10px', maxHeight: '120px', overflowY: 'auto' }}>
                        {legacyAuditResult.listings
                          .filter((l) => l.classification === '1-image')
                          .map((l) => (
                            <div key={l.id} style={{ marginBottom: '3px' }}>
                              {l.title.length > 60 ? `${l.title.slice(0, 57)}...` : l.title}
                              {' · '}
                              <a href={l.ebayLink} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>
                                {l.ebayListingId} ↗
                              </a>
                            </div>
                          ))}
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          className="btn btn-solid btn-sm"
                          style={{ background: 'var(--red)', borderColor: 'var(--red)' }}
                          onClick={() => {
                            const ids = legacyAuditResult.listings.filter((l) => l.classification === '1-image').map((l) => l.id)
                            confirmEndLegacyListings(ids)
                          }}
                        >
                          Yes — end {legacyAuditResult.summary.oneImage} listing{legacyAuditResult.summary.oneImage !== 1 ? 's' : ''} on eBay
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setLegacyEndState('idle')}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {legacyEndState === 'ending' && (
                    <div style={{ fontSize: '13px', color: 'var(--muted)' }}>{legacyEndMsg}</div>
                  )}
                  {(legacyEndState === 'done' || legacyEndState === 'error') && (
                    <div style={{ fontSize: '13px', color: legacyEndState === 'error' ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{legacyEndMsg}</div>
                  )}
                </div>
              )}

              {/* Full results table */}
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Listing</th>
                      <th>Live images</th>
                      <th>Classification</th>
                      <th>Suggested action</th>
                      <th>Listed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legacyAuditResult.listings.length === 0 ? (
                      <tr><td colSpan={5}>No legacy listings found.</td></tr>
                    ) : legacyAuditResult.listings.map((listing) => (
                      <tr key={listing.id}>
                        <td>
                          <strong>{listing.title.length > 60 ? `${listing.title.slice(0, 57)}...` : listing.title}</strong>
                          <span>
                            {listing.asin}
                            {' · '}
                            <a href={listing.ebayLink} target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}>
                              eBay {listing.ebayListingId} ↗
                            </a>
                          </span>
                        </td>
                        <td>
                          <strong style={{
                            color: listing.liveImageCount === null ? 'var(--muted)'
                              : listing.liveImageCount <= 1 ? 'var(--red)'
                              : listing.liveImageCount === 2 ? 'var(--gold)'
                              : 'var(--green)'
                          }}>
                            {listing.liveImageCount === null ? '?' : listing.liveImageCount}
                          </strong>
                        </td>
                        <td>
                          <span className={`admin-pill admin-pill-${
                            listing.classification === '1-image' ? 'bad'
                            : listing.classification === 'unverified' ? 'neutral'
                            : listing.classification === '2-images' ? 'watch'
                            : 'good'
                          }`}>
                            {listing.classification}
                          </span>
                        </td>
                        <td style={{ fontSize: '11px', color: 'var(--muted)' }}>{listing.suggestedAction}</td>
                        <td>{listing.listedAt ? new Date(listing.listedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
                <button className="btn btn-ghost btn-sm" onClick={runLegacyAudit}>
                  Re-run audit
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Recent source jobs</span>
              <h2>Crawls, scoring, and self-healing history</h2>
            </div>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table admin-source-runs-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Pool impact</th>
                  <th>Ready</th>
                  <th>Duration</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {!intelligence?.recentRuns?.length ? (
                  <tr><td colSpan={6}>No source job history yet. Run Quick Refresh or wait for the production cron.</td></tr>
                ) : intelligence.recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <strong>{run.mode}</strong>
                      <span>{run.trigger}</span>
                    </td>
                    <td>
                      <span className={`admin-pill admin-pill-${run.status === 'success' ? 'good' : run.status === 'partial' ? 'watch' : 'bad'}`}>
                        {run.status}
                      </span>
                      {run.error ? <span>{truncate(run.error, 80)}</span> : null}
                    </td>
                    <td>
                      <strong>{formatNumber(run.readyToList)} ready after run</strong>
                      <span>{formatNumber(run.productsRejected)} cleaned</span>
                    </td>
                    <td>{formatNumber(run.readyToList)}</td>
                    <td>{formatDuration(run.durationMs)}</td>
                    <td>{formatDateTime(run.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-subtle-line">
            Pro cron runs source maintenance every 30 minutes, stocks weak niche caches every hour, and runs deeper catalog crawls every 6 hours.
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Source flow</span>
              <h2>How products become ready to list</h2>
            </div>
          </div>
          <div className="admin-flow-grid">
            <div>
              <strong>1. Source niche</strong>
              <span>StackPilot rotates through active niches and trend-focused Amazon searches.</span>
            </div>
            <div>
              <strong>2. Validate Amazon</strong>
              <span>ASIN, title, price, images, rating, reviews, and availability are checked before use.</span>
            </div>
            <div>
              <strong>3. Score quality</strong>
              <span>Profit, ROI, demand signals, low-risk shipping, reviews, and seasonal trend fit are ranked.</span>
            </div>
            <div>
              <strong>4. Stock queues</strong>
              <span>The best products refill niche pools, Product Listing, and Continuous Listing caches.</span>
            </div>
            <div>
              <strong>5. Guard publish</strong>
              <span>Listing time blocks unavailable Amazon items, duplicates, weak titles, bad pricing, and sparse images.</span>
            </div>
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Trending niches</span>
              <h2>What the source engine is stocking</h2>
            </div>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table admin-trending-table">
              <thead>
                <tr>
                  <th>Niche</th>
                  <th>Status</th>
                  <th>Products</th>
                  <th>Avg profit</th>
                  <th>Avg ROI</th>
                  <th>Score</th>
                  <th>Last refresh</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {stats.sourceHealth.trendingNiches.length === 0 ? (
                  <tr><td colSpan={8}>No trending niche data yet. Run Deep Catalog Crawl to stock the first pools.</td></tr>
                ) : stats.sourceHealth.trendingNiches.map((niche) => (
                  <tr key={niche.name}>
                    <td>
                      <strong>{niche.name}</strong>
                      <span>{niche.missingImages} missing images · {niche.highRiskProducts} high risk</span>
                    </td>
                    <td>
                      <span className={`admin-pill admin-pill-${niche.status === 'ready' ? 'good' : niche.status === 'watch' ? 'watch' : 'bad'}`}>
                        {niche.status === 'ready' ? 'Ready' : niche.status === 'watch' ? 'Needs stock' : 'Low'}
                      </span>
                    </td>
                    <td>
                      <strong>{formatNumber(niche.activeProducts)} source</strong>
                      <span>{formatNumber(niche.cacheProducts)} cache</span>
                    </td>
                    <td>{formatMoney(niche.averageProfit)}</td>
                    <td>{Math.round(niche.averageRoi || 0)}%</td>
                    <td>{Math.round(niche.averageScore || 0)}</td>
                    <td>{formatDateTime(niche.cacheRefreshedAt || niche.latestSeenAt)}</td>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={nicheAction !== null}
                        onClick={() => refreshNiche(niche.name)}
                      >
                        {nicheAction === `refresh:${niche.name}` ? 'Stocking...' : 'Stock now'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-subtle-line">
            Ready means a niche has at least 30 active source products and 30 cached queue products with a recent refresh. Needs stock rows are now picked up automatically by the hourly niche stocker.
          </div>
        </section>

        {/* Pool Health — truly valid per niche after all filters */}
        {poolStatus && (
          <section className="admin-panel" style={{ marginBottom: '20px' }}>
            <div className="admin-panel-head">
              <div>
                <span>Pool health</span>
                <h2>Truly valid products per niche</h2>
                <p style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
                  Counts products that pass all SQL filters AND are not already listed. Sorted weakest first.
                  Pool: <strong>{poolStatus.totalPool.toLocaleString()}</strong> active ·
                  Listed: <strong>{poolStatus.totalAlreadyListed.toLocaleString()}</strong> on eBay ·
                  Truly valid: <strong>{poolStatus.totalTrulyValid.toLocaleString()}</strong>
                </p>
              </div>
              <span className={`admin-pill admin-pill-${poolStatus.validByNiche.filter(n => (n.validCount || 0) < 30).length === 0 ? 'good' : 'watch'}`}>
                {poolStatus.validByNiche.filter(n => (n.validCount || 0) < 30).length} niches under 30
              </span>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Niche</th>
                    <th>Truly Valid</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...poolStatus.validByNiche]
                    .sort((a, b) => (a.validCount || 0) - (b.validCount || 0))
                    .map((row) => {
                      const count = row.validCount || 0
                      const status = count >= 30 ? 'good' : count >= 15 ? 'watch' : 'bad'
                      const label = count >= 30 ? '✓ Ready' : count >= 15 ? '⚠ Low' : '✗ Critical'
                      return (
                        <tr key={row.niche || 'unassigned'}>
                          <td><strong>{row.niche || 'Unassigned'}</strong></td>
                          <td><strong style={{ color: count >= 30 ? 'var(--green)' : count >= 15 ? 'var(--gold)' : 'var(--red)' }}>{count}</strong></td>
                          <td><span className={`admin-pill admin-pill-${status}`}>{label}</span></td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Manage source niches</span>
              <h2>Add or tune product search lanes</h2>
            </div>
          </div>
          <div className="admin-niche-manager">
            <div className="admin-niche-form">
              <label>
                <span>Niche name</span>
                <input
                  value={nicheForm.name}
                  onChange={(event) => setNicheForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Example: Pickleball Accessories"
                />
              </label>
              <label>
                <span>Search queries</span>
                <textarea
                  value={nicheForm.queries}
                  onChange={(event) => setNicheForm((current) => ({ ...current, queries: event.target.value }))}
                  placeholder={'pickleball paddle cover\npickleball ball holder\nportable pickleball net accessories'}
                  rows={7}
                />
              </label>
              <label>
                <span>Notes</span>
                <input
                  value={nicheForm.notes}
                  onChange={(event) => setNicheForm((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="Why this niche matters right now"
                />
              </label>
              <button className="btn btn-solid btn-sm" disabled={nicheAction !== null} onClick={saveSourceNiche}>
                {nicheAction === 'save' ? 'Saving...' : 'Save source niche'}
              </button>
            </div>
            <div className="admin-managed-niches">
              {sourceNiches.length === 0 ? (
                <div className="admin-empty">No custom niches yet. Built-in trending niches are already active.</div>
              ) : sourceNiches.map((niche) => (
                <div key={niche.name} className="admin-managed-niche">
                  <div>
                    <strong>{niche.name}</strong>
                    <span>
                      {niche.queries.length} queries · {niche.active ? 'active' : 'paused'} · updated {formatDateTime(niche.updatedAt)}
                    </span>
                    {niche.notes ? <em>{niche.notes}</em> : null}
                  </div>
                  <div>
                    <button className="btn btn-ghost btn-sm" disabled={nicheAction !== null} onClick={() => editSourceNiche(niche)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" disabled={nicheAction !== null} onClick={() => setSourceNicheActive(niche.name, !niche.active)}>
                      {niche.active ? 'Pause' : 'Enable'}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={nicheAction !== null} onClick={() => refreshNiche(niche.name)}>Refresh</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="admin-grid admin-grid-2">
          <AdminList
            title="Top source niches"
            eyebrow="Pool depth"
            items={stats.sourceHealth.topNiches.map((niche) => ({
              key: niche.name,
              left: niche.name,
              right: `${formatNumber(niche.count)} items`,
              meta: `Avg score ${Math.round(niche.averageScore)} - max ${Math.round(niche.maxScore)}`,
            }))}
          />
          <AdminList
            title="Best listing niches"
            eyebrow="Last 90 days"
            items={stats.nichePerformance.map((niche) => ({
              key: niche.niche,
              left: niche.niche,
              right: formatMoney(niche.profit),
              meta: `${formatNumber(niche.listings)} listings - ${formatNumber(niche.sellers)} seller(s)`,
            }))}
          />
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Problem listings</span>
              <h2>Exact listings behind the warnings</h2>
            </div>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table admin-problem-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Seller</th>
                  <th>Issues</th>
                  <th>Images</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Listed</th>
                </tr>
              </thead>
              <tbody>
                {stats.problemListings.length === 0 ? (
                  <tr><td colSpan={7}>No problem listings found.</td></tr>
                ) : stats.problemListings.map((listing) => (
                  <tr key={listing.id}>
                    <td>
                      <strong>{truncate(listing.title, 74)}</strong>
                      <span>
                        {listing.asin || 'No ASIN'}
                        {listing.ebayListingId ? (
                          <>
                            {' - '}
                            <a href={`https://www.ebay.com/itm/${listing.ebayListingId}`} target="_blank" rel="noreferrer">
                              eBay {listing.ebayListingId}
                            </a>
                          </>
                        ) : ''}
                      </span>
                    </td>
                    <td>
                      <strong>{listing.sellerName || listing.sellerEmail}</strong>
                      <span>{listing.sellerEmail}</span>
                    </td>
                    <td>
                      <div className="admin-issue-stack">
                        {listing.issues.map((issue) => (
                          <span className="admin-issue" key={`${listing.id}-${issue}`}>{issue}</span>
                        ))}
                        <small>{listing.repairHint}</small>
                      </div>
                    </td>
                    <td>
                      <strong>{listing.imageCount}</strong>
                      <span>{listing.cacheImageCount} cached</span>
                    </td>
                    <td>
                      <strong>{listing.categoryId || '-'}</strong>
                      <span>{listing.categoryName || listing.niche}</span>
                    </td>
                    <td>
                      <strong>{formatMoney(listing.ebayPrice)}</strong>
                      <span>Cost {formatMoney(listing.amazonPrice)}</span>
                    </td>
                    <td>{formatDate(listing.listedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stats.problemListings.length >= 100 ? (
            <div className="admin-subtle-line">Showing the first 100 problem listings. Run Fix All, refresh, then review the remaining rows.</div>
          ) : null}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Recent listings</span>
              <h2>Latest published products</h2>
            </div>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Seller</th>
                  <th>Prices</th>
                  <th>Images</th>
                  <th>Category</th>
                  <th>Listed</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentListings.length === 0 ? (
                  <tr><td colSpan={6}>No listings recorded yet.</td></tr>
                ) : stats.recentListings.map((listing) => (
                  <tr key={listing.id}>
                    <td>
                      <strong>{truncate(listing.title, 70)}</strong>
                      <span>{listing.asin}{listing.ebayListingId ? ` - eBay ${listing.ebayListingId}` : ''}</span>
                    </td>
                    <td>
                      <strong>{listing.sellerName || listing.sellerEmail}</strong>
                      <span>{listing.sellerEmail}</span>
                    </td>
                    <td>
                      <strong>{formatMoney(listing.ebayPrice)}</strong>
                      <span>Cost {formatMoney(listing.amazonPrice)}</span>
                    </td>
                    <td>{listing.imageCount}</td>
                    <td>
                      <strong>{listing.categoryId || '-'}</strong>
                      <span>{listing.niche}</span>
                    </td>
                    <td>{formatDate(listing.listedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-head">
            <div>
              <span>Accounts</span>
              <h2>Customer health</h2>
            </div>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>eBay</th>
                  <th>Listings</th>
                  <th>Profit</th>
                  <th>Last listing</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {stats.customers.length === 0 ? (
                  <tr><td colSpan={6}>No customer accounts yet.</td></tr>
                ) : stats.customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <strong>{customer.name || customer.email}</strong>
                      <span>{customer.email}</span>
                    </td>
                    <td>
                      <StatusPill active={customer.ebayConnected} activeText="Connected" inactiveText="Missing" />
                      <span>{formatDate(customer.ebayUpdatedAt)}</span>
                    </td>
                    <td>
                      <strong>{formatNumber(customer.activeListings)} active</strong>
                      <span>{formatNumber(customer.totalListings)} total</span>
                    </td>
                    <td>{formatMoney(customer.activeProfit)}</td>
                    <td>
                      <StatusPill active={customer.activeRecently} activeText="Recent" inactiveText="Quiet" />
                      <span>{formatDate(customer.lastListingAt)}</span>
                    </td>
                    <td>{formatDate(customer.joined)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-panel">
          <details>
            <summary>
              <span>Collaboration log</span>
              <strong>COLLAB.md live notes</strong>
            </summary>
            <p className="admin-collab-source">
              {collabGitSha ? (
                <>
                  Deploy <code>{collabGitSha.slice(0, 7)}</code>
                </>
              ) : (
                <>
                  Deploy <code>unknown</code>
                </>
              )}
              {collabDeploymentId ? (
                <>
                  {' '}
                  · dpl <code>{collabDeploymentId}</code>
                </>
              ) : null}
              {collabFileMtime ? (
                <>
                  {' '}
                  · bundle mtime <code>{collabFileMtime}</code>
                </>
              ) : null}
            </p>
            <pre className="admin-collab">{collab || 'COLLAB.md not loaded.'}</pre>
          </details>
        </section>
      </section>
    </main>
  )
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="admin-metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function SmallStat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' | 'good' }) {
  const toneColor = tone === 'warn' ? 'var(--gold)' : tone === 'bad' ? 'var(--red)' : tone === 'good' ? 'var(--green)' : undefined
  return (
    <div className="admin-small-stat">
      <span>{label}</span>
      <strong style={toneColor ? { color: toneColor } : undefined}>{value}</strong>
    </div>
  )
}

function StatusPill({ active, activeText, inactiveText }: { active: boolean; activeText: string; inactiveText: string }) {
  return (
    <span className={`admin-pill ${active ? 'admin-pill-good' : 'admin-pill-muted'}`}>
      {active ? activeText : inactiveText}
    </span>
  )
}

function AdminList({
  eyebrow,
  title,
  items,
}: {
  eyebrow: string
  title: string
  items: Array<{ key: string; left: string; right: string; meta: string }>
}) {
  return (
    <div className="admin-panel">
      <div className="admin-panel-head">
        <div>
          <span>{eyebrow}</span>
          <h2>{title}</h2>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="admin-empty">No data yet.</div>
      ) : (
        <div className="admin-list">
          {items.map((item) => (
            <div key={item.key}>
              <div>
                <strong>{item.left}</strong>
                <span>{item.meta}</span>
              </div>
              <em>{item.right}</em>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
