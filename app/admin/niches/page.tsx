'use client'

// Phase 1 — Niche health admin UI.
//
// Shows every niche with its lifecycle state, funnel counts, top failure codes,
// and structured "why is this unhealthy" diagnostics. Lets the admin pause/resume
// niches and trigger a full refresh (which also auto-pauses seasonal_expired ones).

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type Diagnostic = {
  code: string
  severity: 'info' | 'warn' | 'block'
  detail: string
}

type Niche = {
  niche: string
  state: 'active' | 'watch' | 'stale' | 'paused' | 'retired' | 'seasonal_expired'
  reason: string
  diagnostics: Diagnostic[]
  activeProducts: number
  enrichedProducts: number
  readyProducts: number
  cacheProducts: number
  activeListings: number
  listed30d: number
  completedQueue30d: number
  failedQueue30d: number
  preflightFailures24h: number
  topFailureCodes: Array<{ code: string; count: number }>
  avgProfit: number
  avgRoi: number
  healthScore: number
  lastSuccessfulListingAt: string | null
  lastCacheAt: string | null
  lastSeenAt: string | null
  paused: boolean
}

type Payload = {
  generatedAt: string
  niches: Niche[]
  summary: {
    total: number
    active: number
    watch: number
    stale: number
    paused: number
    seasonalExpired: number
    totalReady: number
    totalActive: number
  }
}

type FilterState = 'all' | 'active' | 'watch' | 'stale' | 'paused' | 'seasonal_expired' | 'unhealthy'

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(Math.round(value || 0))
}

function formatDateTime(value: string | null) {
  if (!value) return 'Never'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function daysSince(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Math.floor((Date.now() - date.getTime()) / 86_400_000)
}

function stateTone(state: Niche['state']): 'good' | 'watch' | 'bad' | 'neutral' {
  if (state === 'active') return 'good'
  if (state === 'watch') return 'watch'
  if (state === 'stale') return 'bad'
  return 'neutral'
}

function stateLabel(state: Niche['state']): string {
  const labels = { active: 'Active', watch: 'Watch', stale: 'Stale', paused: 'Paused', retired: 'Retired', seasonal_expired: 'Seasonal Off' }
  return labels[state] || state
}

function severityColor(sev: Diagnostic['severity']) {
  if (sev === 'block') return '#ef4444'
  if (sev === 'warn') return '#facc15'
  return '#60a5fa'
}

export default function AdminNichesPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterState>('all')
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [expandedNiche, setExpandedNiche] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<{ tone: 'info' | 'success' | 'error'; message: string } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/niche-health', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setData(json as Payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load niche health.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.replace('/login?next=/admin/niches')
      return
    }
    load()
  }, [status, router, load])

  const refresh = async (autoPause: boolean) => {
    setRefreshing(true)
    setActionMsg({ tone: 'info', message: autoPause ? 'Refreshing + auto-pausing seasonal_expired...' : 'Refreshing lifecycle state...' })
    try {
      const res = await fetch('/api/admin/niche-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh', autoPause }),
      })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      const paused = (json.pausedSeasonalNiches || []) as string[]
      setActionMsg({
        tone: 'success',
        message: paused.length > 0
          ? `Refreshed ${json.niches} niches. Auto-paused: ${paused.join(', ')}.`
          : `Refreshed ${json.niches} niches.`,
      })
      await load()
    } catch (err) {
      setActionMsg({ tone: 'error', message: err instanceof Error ? err.message : 'Refresh failed.' })
    } finally {
      setRefreshing(false)
    }
  }

  const setNicheActive = async (niche: string, active: boolean) => {
    setActionMsg({ tone: 'info', message: `${active ? 'Resuming' : 'Pausing'} ${niche}...` })
    try {
      const res = await fetch('/api/admin/niche-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: active ? 'resume' : 'pause', niche }),
      })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setActionMsg({ tone: 'success', message: `${niche} ${active ? 'resumed' : 'paused'}.` })
      await load()
    } catch (err) {
      setActionMsg({ tone: 'error', message: err instanceof Error ? err.message : 'Action failed.' })
    }
  }

  const filteredNiches = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    return data.niches.filter((n) => {
      if (q && !n.niche.toLowerCase().includes(q)) return false
      if (filter === 'all') return true
      if (filter === 'unhealthy') return n.state !== 'active' && n.state !== 'paused'
      return n.state === filter
    })
  }, [data, filter, search])

  if (loading) return <div className="admin-loading">Loading niche health...</div>
  if (error || !data) return <div className="admin-loading admin-loading-error">{error || 'Access denied.'}</div>

  const summary = data.summary

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <Link href="/" className="home-brand" aria-label="StackPilot home">
          Stack<span>Pilot</span>
        </Link>
        <div className="admin-topbar-actions">
          <span>{session?.user?.email}</span>
          <Link href="/admin" className="btn btn-ghost btn-sm">Admin</Link>
          <Link href="/admin/health" className="btn btn-ghost btn-sm">Health</Link>
          <Link href="/admin/performance" className="btn btn-ghost btn-sm">Performance</Link>
          <Link href="/admin/market" className="btn btn-ghost btn-sm">Market</Link>
          <Link href="/admin/discovery" className="btn btn-ghost btn-sm">Discovery</Link>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-hero">
          <div>
            <div className="admin-kicker">Phase 1 — Niche Funnel Intelligence</div>
            <h1>Per-niche lifecycle, diagnostics & seasonal decay</h1>
            <p>
              Every niche is rated as <strong>active / watch / stale / paused / seasonal-off</strong> based on funnel
              throughput (sourced → enriched → ready → listed), failure-log breakdown, and seasonal window.
              Refreshing auto-pauses niches past their seasonal peak (e.g. Fourth of July past July 15).
            </p>
          </div>
          <div className={`admin-status-card admin-status-${summary.stale + summary.seasonalExpired > 5 ? 'attention' : summary.watch > 3 ? 'watch' : 'healthy'}`}>
            <span>Niches</span>
            <strong>{summary.total}</strong>
            <p>{summary.active} active · {summary.watch} watch · {summary.stale} stale · {summary.seasonalExpired} seasonal off · {summary.paused} paused</p>
            <small>Updated {formatDateTime(data.generatedAt)}</small>
          </div>
        </div>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div>
              <span>Actions</span>
              <h2>Refresh lifecycle state</h2>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => refresh(false)} disabled={refreshing}>
                {refreshing ? 'Refreshing...' : 'Refresh only'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => refresh(true)} disabled={refreshing}>
                Refresh + auto-pause seasonal
              </button>
            </div>
          </div>
          {actionMsg && (
            <div
              style={{
                marginTop: '10px',
                padding: '10px 12px',
                borderRadius: '8px',
                border: `1px solid ${actionMsg.tone === 'error' ? '#ef4444' : actionMsg.tone === 'success' ? '#22c55e' : '#60a5fa'}`,
                background: actionMsg.tone === 'error' ? 'rgba(239,68,68,0.08)' : actionMsg.tone === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(96,165,250,0.08)',
                fontSize: '13px',
              }}
            >
              {actionMsg.message}
            </div>
          )}
        </section>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head" style={{ flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <span>Niche table</span>
              <h2>Funnel: sourced → enriched → ready → listed</h2>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="search"
                placeholder="Filter by name..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(125,211,252,0.2)', background: 'rgba(255,255,255,0.02)', color: 'inherit', fontSize: '13px' }}
              />
              {(['all', 'unhealthy', 'active', 'watch', 'stale', 'paused', 'seasonal_expired'] as FilterState[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ textTransform: 'capitalize' }}
                >
                  {f.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          <div className="admin-table-wrap" style={{ marginTop: '12px' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Niche</th>
                  <th>State</th>
                  <th>Sourced</th>
                  <th>Enriched</th>
                  <th>Ready</th>
                  <th>Listed (30d)</th>
                  <th>Active</th>
                  <th>Fail 24h</th>
                  <th>Health</th>
                  <th>Last sale</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredNiches.length === 0 && (
                  <tr><td colSpan={11} style={{ opacity: 0.6 }}>No niches match this filter.</td></tr>
                )}
                {filteredNiches.map((n) => {
                  const isExpanded = expandedNiche === n.niche
                  const lastSaleDays = daysSince(n.lastSuccessfulListingAt)
                  return (
                    <Fragment key={n.niche}>
                      <tr>
                        <td>
                          <button
                            onClick={() => setExpandedNiche(isExpanded ? null : n.niche)}
                            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, font: 'inherit', textAlign: 'left' }}
                          >
                            <strong>{n.niche}</strong>{' '}
                            <span style={{ opacity: 0.5, fontSize: '11px' }}>{isExpanded ? '▾' : '▸'}</span>
                          </button>
                        </td>
                        <td>
                          <span className={`admin-pill admin-pill-${stateTone(n.state)}`}>
                            {stateLabel(n.state)}
                          </span>
                        </td>
                        <td>{formatNumber(n.activeProducts)}</td>
                        <td>{formatNumber(n.enrichedProducts)}</td>
                        <td><strong>{formatNumber(n.readyProducts)}</strong></td>
                        <td>{formatNumber(n.listed30d)}</td>
                        <td>{formatNumber(n.activeListings)}</td>
                        <td style={{ color: n.preflightFailures24h > 10 ? '#ef4444' : n.preflightFailures24h > 3 ? '#facc15' : undefined }}>
                          {formatNumber(n.preflightFailures24h)}
                        </td>
                        <td><strong>{n.healthScore}</strong></td>
                        <td>
                          <small>
                            {lastSaleDays === null ? 'Never' : lastSaleDays === 0 ? 'Today' : `${lastSaleDays}d ago`}
                          </small>
                        </td>
                        <td>
                          {n.paused ? (
                            <button className="btn btn-ghost btn-sm" onClick={() => setNicheActive(n.niche, true)}>Resume</button>
                          ) : (
                            <button className="btn btn-ghost btn-sm" onClick={() => setNicheActive(n.niche, false)}>Pause</button>
                          )}
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={11} style={{ background: 'rgba(125,211,252,0.04)', padding: '16px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                              <div>
                                <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', textTransform: 'uppercase', opacity: 0.7 }}>Why this state</h4>
                                <p style={{ margin: '0 0 12px 0', fontSize: '13px' }}>{n.reason}</p>
                                <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', textTransform: 'uppercase', opacity: 0.7 }}>Diagnostics</h4>
                                {n.diagnostics.length === 0 ? (
                                  <p style={{ opacity: 0.6, fontSize: '13px' }}>No flagged issues.</p>
                                ) : (
                                  <ul style={{ margin: 0, paddingLeft: '18px' }}>
                                    {n.diagnostics.map((d, idx) => (
                                      <li key={idx} style={{ marginBottom: '6px', fontSize: '13px' }}>
                                        <span style={{ color: severityColor(d.severity), fontWeight: 600 }}>[{d.code}]</span>{' '}
                                        {d.detail}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              <div>
                                <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', textTransform: 'uppercase', opacity: 0.7 }}>Top failure codes (24h)</h4>
                                {n.topFailureCodes.length === 0 ? (
                                  <p style={{ opacity: 0.6, fontSize: '13px' }}>No failures.</p>
                                ) : (
                                  <table className="admin-table" style={{ fontSize: '12px' }}>
                                    <tbody>
                                      {n.topFailureCodes.slice(0, 8).map((f) => (
                                        <tr key={f.code}>
                                          <td><code>{f.code}</code></td>
                                          <td><strong>{formatNumber(f.count)}</strong></td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                                <h4 style={{ margin: '12px 0 8px 0', fontSize: '12px', textTransform: 'uppercase', opacity: 0.7 }}>Margin</h4>
                                <p style={{ margin: 0, fontSize: '13px' }}>
                                  Avg profit ${n.avgProfit.toFixed(2)} · ROI {Math.round(n.avgRoi)}% · Cache age {n.lastCacheAt ? `${formatDateTime(n.lastCacheAt)}` : 'never'}
                                </p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="admin-subtle-line" style={{ marginTop: '12px' }}>
            <strong>Funnel definitions:</strong> Sourced = active product_source_items.{' '}
            Enriched = sourced + has Amazon cache + ≥2 images.{' '}
            Ready = passes all preflight gates (price/ROI/risk/image/availability).{' '}
            Listed = currently live on eBay.
          </div>
        </section>
      </section>
    </main>
  )
}
