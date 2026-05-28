'use client'

// Phase 3 — Market saturation & inventory quality admin view.
//
// Surfaces: top saturated niches, healthiest low-competition niches, margin stability,
// average repricing pressure, oversupplied vs undersupplied, biggest duplicate clusters,
// sourcing concentration, and race-to-bottom products.

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type NicheRow = {
  niche: string
  avg_saturation?: number | null
  avg_inventory_quality?: number | null
  avg_pricing_pressure?: number | null
  avg_roi?: number | null
  avg_profit?: number | null
  sell_through_rate?: number | null
  supply_demand_ratio?: number | null
  concentration_pct?: number | null
  active_products?: number
  sold_30d?: number
}

type DupCluster = {
  dup_cluster_id: string
  sample_title: string
  niche: string | null
  cluster_size: number
  avg_quality?: number | null
}

type RaceRow = {
  asin: string
  title: string
  niche: string | null
  roi?: number | null
  roi_trend?: number | null
  pricing_pressure_score?: number | null
  ebay_competitor_count?: number | null
}

type Payload = {
  generatedAt: string
  topSaturated: NicheRow[]
  healthiestLowComp: NicheRow[]
  marginStability: NicheRow[]
  repricingPressure: NicheRow[]
  supplyDemand: NicheRow[]
  biggestDupClusters: DupCluster[]
  concentration: NicheRow[]
  raceToBottom: RaceRow[]
}

function num(v: unknown) {
  const n = typeof v === 'number' ? v : Number(v || 0)
  return Number.isFinite(n) ? n : 0
}
function fmt(v: unknown) { return new Intl.NumberFormat('en-US').format(Math.round(num(v))) }
function pct(v: unknown) { return `${Math.round(num(v) * 100)}%` }
function score(v: unknown) { return v == null ? '—' : Math.round(num(v)).toString() }
function truncate(v: string, n = 48) { return !v ? '-' : v.length > n ? `${v.slice(0, n - 1)}…` : v }

function satTone(v: unknown): 'good' | 'watch' | 'bad' {
  const n = num(v)
  if (n >= 70) return 'bad'
  if (n >= 45) return 'watch'
  return 'good'
}
function qualityTone(v: unknown): 'good' | 'watch' | 'bad' {
  const n = num(v)
  if (n >= 65) return 'good'
  if (n >= 45) return 'watch'
  return 'bad'
}

export default function AdminMarketPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'info' | 'success' | 'error'; message: string } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/market-saturation', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setData(json as Payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load market data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.replace('/login?next=/admin/market')
      return
    }
    load()
  }, [status, router, load])

  const refresh = async () => {
    setRefreshing(true)
    setMsg({ tone: 'info', message: 'Recomputing saturation, pricing pressure, dup clusters, quality...' })
    try {
      const res = await fetch('/api/admin/market-saturation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setMsg({
        tone: 'success',
        message: `Done. ${json.clusters?.duplicateGroups ?? 0} dup groups (${json.clusters?.clusteredProducts ?? 0} products clustered).`,
      })
      await load()
    } catch (err) {
      setMsg({ tone: 'error', message: err instanceof Error ? err.message : 'Refresh failed.' })
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) return <div className="admin-loading">Loading market intelligence...</div>
  if (error || !data) return <div className="admin-loading admin-loading-error">{error || 'Access denied.'}</div>

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
          <Link href="/admin/niches" className="btn btn-ghost btn-sm">Niches</Link>
          <Link href="/admin/performance" className="btn btn-ghost btn-sm">Performance</Link>
          <Link href="/admin/discovery" className="btn btn-ghost btn-sm">Discovery</Link>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-hero">
          <div>
            <div className="admin-kicker">Phase 3 — Market Saturation & Inventory Quality</div>
            <h1>What sells profitably and sustainably</h1>
            <p>
              Beyond &quot;what sells&quot;: saturation density, race-to-bottom pricing pressure, duplicate
              clustering, and a composite inventory-quality score now steer sourcing toward stable-margin,
              low-competition products and away from hyperviral overcrowded junk.
            </p>
          </div>
          <div className="admin-status-card admin-status-healthy">
            <span>Saturation engine</span>
            <strong>Active</strong>
            <p>Quality + dup suppression wired into sourcing</p>
            <small>Updated {new Date(data.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
          </div>
        </div>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div><span>Actions</span><h2>Recompute saturation intelligence</h2></div>
            <button className="btn btn-primary btn-sm" onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Recomputing...' : 'Recompute now'}
            </button>
          </div>
          {msg && (
            <div style={{
              marginTop: '10px', padding: '10px 12px', borderRadius: '8px', fontSize: '13px',
              border: `1px solid ${msg.tone === 'error' ? '#ef4444' : msg.tone === 'success' ? '#22c55e' : '#60a5fa'}`,
              background: msg.tone === 'error' ? 'rgba(239,68,68,0.08)' : msg.tone === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(96,165,250,0.08)',
            }}>{msg.message}</div>
          )}
        </section>

        {/* Healthiest low-competition niches */}
        <Panel title="Healthiest low-competition niches" subtitle="High inventory quality, low saturation — scale these">
          <table className="admin-table">
            <thead><tr><th>Niche</th><th>Quality</th><th>Saturation</th><th>Sell-through</th><th>Products</th></tr></thead>
            <tbody>
              {data.healthiestLowComp.length === 0 && <tr><td colSpan={5} style={{ opacity: 0.6 }}>No data yet — run recompute.</td></tr>}
              {data.healthiestLowComp.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className={`admin-pill admin-pill-${qualityTone(n.avg_inventory_quality)}`}>{score(n.avg_inventory_quality)}</span></td>
                  <td><span className={`admin-pill admin-pill-${satTone(n.avg_saturation)}`}>{score(n.avg_saturation)}</span></td>
                  <td>{pct(n.sell_through_rate)}</td>
                  <td>{fmt(n.active_products)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Top saturated niches */}
        <Panel title="Most saturated niches" subtitle="Overcrowded — throttle sourcing here">
          <table className="admin-table">
            <thead><tr><th>Niche</th><th>Saturation</th><th>Quality</th><th>Products</th><th>Sold 30d</th></tr></thead>
            <tbody>
              {data.topSaturated.length === 0 && <tr><td colSpan={5} style={{ opacity: 0.6 }}>No data yet.</td></tr>}
              {data.topSaturated.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className={`admin-pill admin-pill-${satTone(n.avg_saturation)}`}>{score(n.avg_saturation)}</span></td>
                  <td>{score(n.avg_inventory_quality)}</td>
                  <td>{fmt(n.active_products)}</td>
                  <td>{fmt(n.sold_30d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Margin stability */}
        <Panel title="Most margin-stable niches" subtitle="Low repricing pressure = durable margins">
          <table className="admin-table">
            <thead><tr><th>Niche</th><th>Pricing pressure</th><th>Avg ROI</th><th>Avg profit</th><th>Products</th></tr></thead>
            <tbody>
              {data.marginStability.length === 0 && <tr><td colSpan={5} style={{ opacity: 0.6 }}>No data yet.</td></tr>}
              {data.marginStability.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className="admin-pill admin-pill-good">{score(n.avg_pricing_pressure)}</span></td>
                  <td>{Math.round(num(n.avg_roi))}%</td>
                  <td>${num(n.avg_profit).toFixed(2)}</td>
                  <td>{fmt(n.active_products)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Repricing pressure (worst) */}
        <Panel title="Highest repricing pressure" subtitle="Repricers forced down often — race-to-bottom risk">
          <table className="admin-table">
            <thead><tr><th>Niche</th><th>Pricing pressure</th><th>Avg ROI</th><th>Products</th></tr></thead>
            <tbody>
              {data.repricingPressure.length === 0 && <tr><td colSpan={4} style={{ opacity: 0.6 }}>No data yet.</td></tr>}
              {data.repricingPressure.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className={`admin-pill admin-pill-${satTone(n.avg_pricing_pressure)}`}>{score(n.avg_pricing_pressure)}</span></td>
                  <td>{Math.round(num(n.avg_roi))}%</td>
                  <td>{fmt(n.active_products)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Supply vs demand */}
        <Panel title="Oversupplied vs undersupplied" subtitle="Active products per sale (30d) — high = oversupplied">
          <table className="admin-table">
            <thead><tr><th>Niche</th><th>Supply/Demand</th><th>Active</th><th>Sold 30d</th><th>Sell-through</th></tr></thead>
            <tbody>
              {data.supplyDemand.length === 0 && <tr><td colSpan={5} style={{ opacity: 0.6 }}>No data yet.</td></tr>}
              {data.supplyDemand.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className={`admin-pill admin-pill-${num(n.supply_demand_ratio) > 50 ? 'bad' : num(n.supply_demand_ratio) > 20 ? 'watch' : 'good'}`}>{fmt(n.supply_demand_ratio)}:1</span></td>
                  <td>{fmt(n.active_products)}</td>
                  <td>{fmt(n.sold_30d)}</td>
                  <td>{pct(n.sell_through_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Sourcing concentration */}
        <Panel title="Sourcing concentration" subtitle="Share of total active pool — watch for over-concentration">
          <table className="admin-table">
            <thead><tr><th>Niche</th><th>% of pool</th><th>Products</th><th>Quality</th></tr></thead>
            <tbody>
              {data.concentration.length === 0 && <tr><td colSpan={4} style={{ opacity: 0.6 }}>No data yet.</td></tr>}
              {data.concentration.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className={`admin-pill admin-pill-${num(n.concentration_pct) > 0.25 ? 'bad' : num(n.concentration_pct) > 0.15 ? 'watch' : 'good'}`}>{pct(n.concentration_pct)}</span></td>
                  <td>{fmt(n.active_products)}</td>
                  <td>{score(n.avg_inventory_quality)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Biggest duplicate clusters */}
        <Panel title="Biggest duplicate clusters" subtitle="Near-identical products — only the best member is sourced">
          <table className="admin-table">
            <thead><tr><th>Sample title</th><th>Niche</th><th>Cluster size</th><th>Avg quality</th></tr></thead>
            <tbody>
              {data.biggestDupClusters.length === 0 && <tr><td colSpan={4} style={{ opacity: 0.6 }}>No duplicate clusters found.</td></tr>}
              {data.biggestDupClusters.map((c) => (
                <tr key={c.dup_cluster_id}>
                  <td title={c.sample_title}>{truncate(c.sample_title)}</td>
                  <td>{c.niche || '—'}</td>
                  <td><span className={`admin-pill admin-pill-${c.cluster_size > 5 ? 'bad' : 'watch'}`}>{fmt(c.cluster_size)}</span></td>
                  <td>{score(c.avg_quality)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Race to bottom */}
        <Panel title="Race-to-bottom products" subtitle="High pricing pressure + collapsing ROI — candidates to drop">
          <table className="admin-table">
            <thead><tr><th>Product</th><th>Niche</th><th>ROI</th><th>ROI trend</th><th>Pressure</th><th>Competitors</th></tr></thead>
            <tbody>
              {data.raceToBottom.length === 0 && <tr><td colSpan={6} style={{ opacity: 0.6 }}>No race-to-bottom products detected.</td></tr>}
              {data.raceToBottom.map((p) => (
                <tr key={p.asin}>
                  <td title={p.title}>{truncate(p.title)}</td>
                  <td>{p.niche || '—'}</td>
                  <td>{Math.round(num(p.roi))}%</td>
                  <td style={{ color: num(p.roi_trend) < 0 ? '#ef4444' : undefined }}>{num(p.roi_trend) > 0 ? '+' : ''}{num(p.roi_trend).toFixed(1)}%</td>
                  <td><span className="admin-pill admin-pill-bad">{score(p.pricing_pressure_score)}</span></td>
                  <td>{p.ebay_competitor_count != null ? fmt(p.ebay_competitor_count) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <div className="admin-subtle-line" style={{ marginTop: '16px' }}>
          <strong>How it steers sourcing:</strong> inventory-quality score becomes a 0.75–1.15× multiplier on each
          product&apos;s sourcing score; non-best members of a duplicate cluster get a 0.55× penalty. Saturation is a
          log-normalized competitor count; pricing pressure blends downward-reprice frequency with ROI collapse.
        </div>
      </section>
    </main>
  )
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="admin-panel" style={{ marginTop: '16px' }}>
      <div className="admin-panel-head">
        <div><span>{subtitle}</span><h2>{title}</h2></div>
      </div>
      <div className="admin-table-wrap" style={{ marginTop: '10px' }}>{children}</div>
    </section>
  )
}
