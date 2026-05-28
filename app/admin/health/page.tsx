'use client'

// Phase 0 — System health & quota dashboard.
//
// Renders the snapshot from /api/admin/health: pool depth, listings, eBay/RapidAPI/Anthropic
// quotas with red/yellow banners, failure log breakdown, cache freshness, and reprice lag.
// Uses the same admin-* CSS primitives as the main admin page so styling stays consistent.

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type QuotaEntry = {
  provider: string
  callName: string
  rule: { dailyHardLimit: number; hourlyHardLimit: number; warnPct: number; blockPct: number }
  dailyUsage: number
  hourlyUsage: number
  dailyPct: number
  hourlyPct: number
  status: 'ok' | 'warn' | 'block'
  recentFailures: number
}

type ProviderTotal = {
  provider: string
  dailyTotal: number
  hourlyTotal: number
  failures24h: number
  status: 'ok' | 'warn' | 'block'
}

type Warning = { level: 'warn' | 'block'; title: string; message: string }

type Health = {
  generatedAt: string
  pool: { active: number; cached: number; with_2plus_images: number }
  listings: {
    active: number
    withImageWarning: number
    listedToday: number
    listedLast7Days: number
    cronListedToday: number
  }
  failures24h: {
    byCode: Array<{ errorCode: string; count: number; lastAt: string | null }>
    byStage: Array<{ stage: string; count: number }>
  }
  repricing: {
    activeListings: number
    neverRepriced: number
    staleReprice: number
    medianLagHours: number | string | null
  } | null
  cacheFreshness: { fresh_6h: number; fresh_24h: number; fresh_7d: number; stale_7d_plus: number }
  listingsCloseToStale: { stale_24h: number; stale_72h: number; stale_7d: number }
  apiQuotas: QuotaEntry[]
  providerTotals: ProviderTotal[]
  warnings: Warning[]
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(Math.round(value || 0))
}

function formatDateTime(value: string | null) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function pctLabel(pct: number) {
  return `${Math.round(pct * 100)}%`
}

function quotaPillTone(status: 'ok' | 'warn' | 'block'): 'good' | 'watch' | 'bad' {
  if (status === 'block') return 'bad'
  if (status === 'warn') return 'watch'
  return 'good'
}

function statusLabel(status: 'ok' | 'warn' | 'block') {
  if (status === 'block') return 'BLOCK'
  if (status === 'warn') return 'WARN'
  return 'OK'
}

export default function AdminHealthPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [health, setHealth] = useState<Health | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/health', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error?.message || data?.message || `Request failed (${res.status})`)
      }
      setHealth(data as Health)
      setLastLoadedAt(new Date().toISOString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load health snapshot.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.replace('/login?next=/admin/health')
      return
    }
    load()
    const id = setInterval(load, 60_000) // refresh every minute
    return () => clearInterval(id)
  }, [status, router, load])

  if (loading) {
    return <div className="admin-loading">Loading health snapshot...</div>
  }

  if (error || !health) {
    return <div className="admin-loading admin-loading-error">{error || 'Access denied.'}</div>
  }

  const cacheTotal =
    health.cacheFreshness.fresh_6h +
    health.cacheFreshness.fresh_24h +
    health.cacheFreshness.fresh_7d +
    health.cacheFreshness.stale_7d_plus
  const cacheStalePct = cacheTotal > 0 ? Math.round((health.cacheFreshness.stale_7d_plus / cacheTotal) * 100) : 0

  const overallStatus: 'healthy' | 'watch' | 'attention' =
    health.warnings.some((w) => w.level === 'block') ? 'attention' :
    health.warnings.length > 0 ? 'watch' : 'healthy'

  const overallLabel = overallStatus === 'attention' ? 'Listings blocked' : overallStatus === 'watch' ? 'Watching limits' : 'All systems normal'

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <Link href="/" className="home-brand" aria-label="StackPilot home">
          Stack<span>Pilot</span>
        </Link>
        <div className="admin-topbar-actions">
          <span>{session?.user?.email}</span>
          <Link href="/admin" className="btn btn-ghost btn-sm">Admin</Link>
          <Link href="/admin/niches" className="btn btn-ghost btn-sm">Niches</Link>
          <Link href="/admin/performance" className="btn btn-ghost btn-sm">Performance</Link>
          <Link href="/admin/market" className="btn btn-ghost btn-sm">Market</Link>
          <Link href="/admin/discovery" className="btn btn-ghost btn-sm">Discovery</Link>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-hero">
          <div>
            <div className="admin-kicker">Phase 0 — Health & Quotas</div>
            <h1>System protection dashboard</h1>
            <p>
              Live view of pool depth, eBay/RapidAPI/Anthropic quota usage, listing failures, and reprice lag. When a quota
              hits the warn threshold (70%), cron auto-listing throttles itself. At block (90%), manual listings are
              refused with a clean error instead of failing at eBay.
            </p>
          </div>
          <div className={`admin-status-card admin-status-${overallStatus}`}>
            <span>Status</span>
            <strong>{overallLabel}</strong>
            <p>{health.warnings.length} active warning{health.warnings.length !== 1 ? 's' : ''}</p>
            <small>Updated {formatDateTime(health.generatedAt)}</small>
          </div>
        </div>

        {health.warnings.length > 0 && (
          <section className="admin-panel" style={{ marginTop: '16px' }}>
            <div className="admin-panel-head">
              <div>
                <span>Active alerts</span>
                <h2>What needs attention right now</h2>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {health.warnings.map((w, idx) => (
                <div
                  key={idx}
                  style={{
                    border: `1px solid ${w.level === 'block' ? '#ef4444' : '#facc15'}`,
                    background: w.level === 'block' ? 'rgba(239, 68, 68, 0.07)' : 'rgba(250, 204, 21, 0.07)',
                    padding: '12px 14px',
                    borderRadius: '8px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span className={`admin-pill admin-pill-${w.level === 'block' ? 'bad' : 'watch'}`}>
                      {w.level.toUpperCase()}
                    </span>
                    <strong>{w.title}</strong>
                  </div>
                  <p style={{ margin: '6px 0 0 0', fontSize: '13px', opacity: 0.85 }}>{w.message}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="admin-metrics-grid" style={{ marginTop: '16px' }}>
          <MetricCard label="Source pool (active)" value={formatNumber(health.pool.active)} detail={`${formatNumber(health.pool.cached)} cached, ${formatNumber(health.pool.with_2plus_images)} have 2+ images`} />
          <MetricCard label="Active listings" value={formatNumber(health.listings.active)} detail={`${health.listings.withImageWarning} flagged with image warnings`} />
          <MetricCard label="Listed today" value={formatNumber(health.listings.listedToday)} detail={`${formatNumber(health.listings.cronListedToday)} via cron, ${formatNumber(health.listings.listedLast7Days)} in 7d`} />
          <MetricCard
            label="Failures (24h)"
            value={formatNumber(health.failures24h.byCode.reduce((s, e) => s + e.count, 0))}
            detail={health.failures24h.byCode[0] ? `Top: ${health.failures24h.byCode[0].errorCode}` : 'No failures logged'}
          />
        </div>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div>
              <span>External API quotas</span>
              <h2>Per-provider usage in last 24h / 1h</h2>
            </div>
          </div>

          <div className="admin-health-grid" style={{ marginBottom: '14px' }}>
            {health.providerTotals.map((total) => (
              <div key={total.provider} className="admin-small-stat">
                <span>{total.provider}</span>
                <strong>{formatNumber(total.dailyTotal)}</strong>
                <small>
                  <span className={`admin-pill admin-pill-${quotaPillTone(total.status)}`}>{statusLabel(total.status)}</span>
                  {' '}{formatNumber(total.hourlyTotal)} this hour · {total.failures24h} fails
                </small>
              </div>
            ))}
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Call</th>
                  <th>Daily</th>
                  <th>Hourly</th>
                  <th>Failures 24h</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {health.apiQuotas.length === 0 && (
                  <tr><td colSpan={6} style={{ opacity: 0.6 }}>No API calls logged yet. Tracking starts as soon as listings run.</td></tr>
                )}
                {health.apiQuotas
                  .slice()
                  .sort((a, b) => b.dailyPct - a.dailyPct)
                  .map((entry) => (
                    <tr key={`${entry.provider}:${entry.callName}`}>
                      <td>{entry.provider}</td>
                      <td>{entry.callName}</td>
                      <td>
                        <strong>{formatNumber(entry.dailyUsage)}</strong> / {formatNumber(entry.rule.dailyHardLimit)}{' '}
                        <small style={{ opacity: 0.6 }}>({pctLabel(entry.dailyPct)})</small>
                      </td>
                      <td>
                        {formatNumber(entry.hourlyUsage)} / {formatNumber(entry.rule.hourlyHardLimit)}{' '}
                        <small style={{ opacity: 0.6 }}>({pctLabel(entry.hourlyPct)})</small>
                      </td>
                      <td>{entry.recentFailures}</td>
                      <td>
                        <span className={`admin-pill admin-pill-${quotaPillTone(entry.status)}`}>
                          {statusLabel(entry.status)}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="admin-subtle-line" style={{ marginTop: '10px' }}>
            <strong>WARN (70%)</strong>: cron auto-listing and reprice agent skip this cycle.{' '}
            <strong>BLOCK (90%)</strong>: manual listings refused with EBAY_QUOTA_BLOCKED. Limits reset at the top of the hour and at midnight Pacific.
          </div>
        </section>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div>
              <span>Listing failures (24h)</span>
              <h2>Why listings failed — by error code and pipeline stage</h2>
            </div>
            <span className={`admin-pill admin-pill-${health.failures24h.byCode.length > 10 ? 'bad' : health.failures24h.byCode.length > 3 ? 'watch' : 'good'}`}>
              {formatNumber(health.failures24h.byCode.reduce((s, e) => s + e.count, 0))} failures
            </span>
          </div>

          {health.failures24h.byCode.length === 0 ? (
            <p style={{ opacity: 0.6, margin: '8px 0 0 0' }}>No failures logged in the last 24 hours. Pipeline is clean.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', textTransform: 'uppercase', opacity: 0.7 }}>By error code</h4>
                <table className="admin-table">
                  <thead><tr><th>Code</th><th>Count</th><th>Last</th></tr></thead>
                  <tbody>
                    {health.failures24h.byCode.map((row) => (
                      <tr key={row.errorCode}>
                        <td><code>{row.errorCode}</code></td>
                        <td><strong>{formatNumber(row.count)}</strong></td>
                        <td><small>{formatDateTime(row.lastAt)}</small></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', textTransform: 'uppercase', opacity: 0.7 }}>By pipeline stage</h4>
                <table className="admin-table">
                  <thead><tr><th>Stage</th><th>Count</th></tr></thead>
                  <tbody>
                    {health.failures24h.byStage.map((row) => (
                      <tr key={row.stage}>
                        <td><code>{row.stage}</code></td>
                        <td><strong>{formatNumber(row.count)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div>
              <span>Repricing health</span>
              <h2>How fresh are our eBay prices vs. Amazon</h2>
            </div>
          </div>
          <div className="admin-health-grid">
            <SmallStat label="Active priceable" value={formatNumber(health.repricing?.activeListings || 0)} />
            <SmallStat
              label="Never repriced"
              value={formatNumber(health.repricing?.neverRepriced || 0)}
              tone={(health.repricing?.neverRepriced || 0) > 50 ? 'warn' : undefined}
            />
            <SmallStat
              label="Stale (>24h)"
              value={formatNumber(health.repricing?.staleReprice || 0)}
              tone={
                (health.repricing?.staleReprice || 0) > (health.repricing?.activeListings || 1) * 0.5
                  ? 'bad'
                  : (health.repricing?.staleReprice || 0) > (health.repricing?.activeListings || 1) * 0.25
                    ? 'warn'
                    : undefined
              }
            />
            <SmallStat
              label="Median lag"
              value={`${health.repricing?.medianLagHours ?? '—'}h`}
            />
          </div>
        </section>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div>
              <span>Amazon cache freshness</span>
              <h2>How current is the supplemental product data</h2>
            </div>
            <span className={`admin-pill admin-pill-${cacheStalePct > 30 ? 'bad' : cacheStalePct > 15 ? 'watch' : 'good'}`}>
              {cacheStalePct}% stale
            </span>
          </div>
          <div className="admin-health-grid">
            <SmallStat label="Fresh ≤6h" value={formatNumber(health.cacheFreshness.fresh_6h)} />
            <SmallStat label="Fresh ≤24h" value={formatNumber(health.cacheFreshness.fresh_24h)} />
            <SmallStat label="Fresh ≤7d" value={formatNumber(health.cacheFreshness.fresh_7d)} />
            <SmallStat
              label="Stale >7d / missing"
              value={formatNumber(health.cacheFreshness.stale_7d_plus)}
              tone={health.cacheFreshness.stale_7d_plus > cacheTotal * 0.3 ? 'bad' : health.cacheFreshness.stale_7d_plus > cacheTotal * 0.15 ? 'warn' : undefined}
            />
          </div>
          <div className="admin-subtle-line" style={{ marginTop: '10px' }}>
            Active listings whose Amazon snapshot is stale → repricing decisions may be based on old prices.
          </div>
          <div className="admin-health-grid" style={{ marginTop: '10px' }}>
            <SmallStat label="Listings cache stale 24h+" value={formatNumber(health.listingsCloseToStale.stale_24h)} />
            <SmallStat label="Listings cache stale 72h+" value={formatNumber(health.listingsCloseToStale.stale_72h)} tone={health.listingsCloseToStale.stale_72h > 50 ? 'warn' : undefined} />
            <SmallStat label="Listings cache stale 7d+" value={formatNumber(health.listingsCloseToStale.stale_7d)} tone={health.listingsCloseToStale.stale_7d > 20 ? 'bad' : undefined} />
          </div>
        </section>

        <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: 0.6, fontSize: '12px' }}>
          <span>Auto-refreshes every 60s. Last load: {formatDateTime(lastLoadedAt)}.</span>
          <button className="btn btn-ghost btn-sm" onClick={() => load()}>Refresh now</button>
        </div>
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
