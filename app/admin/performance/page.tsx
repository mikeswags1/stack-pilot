'use client'

// Phase 2 — Top performers / learning-loop admin view.
//
// Shows what actually performs on eBay (not just what passes preflight):
//   - Best & worst niches by sell-through
//   - Fastest-moving listings (days to sale)
//   - Top products by performance score
//   - Worst stale listings (active >30d, unsold, low engagement)
//   - Highest refund/cancel niches

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type NicheRow = {
  niche: string
  listed_30d?: number
  sold_30d?: number
  sell_through_rate?: number
  avg_days_to_sale?: number | null
  realized_profit_30d?: number
  outcome_multiplier?: number
  avg_performance_score?: number | null
  cancel_rate?: number
  refund_rate?: number
}

type ListingRow = {
  asin: string
  title: string
  niche: string
  ebay_price?: number
  sale_price?: number | null
  realized_profit?: number | null
  days_to_sale?: number | null
  watch_count?: number
  hit_count?: number
  reduction_count?: number
  age_days?: number
  performance_score?: number | null
  sold_at?: string | null
  quantity_sold?: number
}

type Payload = {
  generatedAt: string
  bestNiches: NicheRow[]
  worstNiches: NicheRow[]
  fastestListings: ListingRow[]
  topProducts: ListingRow[]
  staleListings: ListingRow[]
  highRefundNiches: NicheRow[]
}

function num(value: unknown) {
  const n = typeof value === 'number' ? value : Number(value || 0)
  return Number.isFinite(n) ? n : 0
}

function formatNumber(value: unknown) {
  return new Intl.NumberFormat('en-US').format(Math.round(num(value)))
}

function formatMoney(value: unknown) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(num(value))
}

function formatPct(value: unknown) {
  return `${Math.round(num(value) * 100)}%`
}

function truncate(value: string, length = 48) {
  if (!value) return '-'
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

export default function AdminPerformancePage() {
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
      const res = await fetch('/api/admin/top-performers', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setData(json as Payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load performance data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') {
      router.replace('/login?next=/admin/performance')
      return
    }
    load()
  }, [status, router, load])

  const refresh = async () => {
    setRefreshing(true)
    setMsg({ tone: 'info', message: 'Pulling fresh eBay sales + rescoring the learning loop...' })
    try {
      const res = await fetch('/api/admin/top-performers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setMsg({
        tone: 'success',
        message: `Rescored ${json.scoring?.scored ?? 0} listings, updated ${json.niche?.nichesUpdated ?? 0} niches. Sales found: ${json.sales?.listingsUpdated ?? 0}.`,
      })
      await load()
    } catch (err) {
      setMsg({ tone: 'error', message: err instanceof Error ? err.message : 'Refresh failed.' })
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) return <div className="admin-loading">Loading performance intelligence...</div>
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
          <Link href="/admin/market" className="btn btn-ghost btn-sm">Market</Link>
          <Link href="/admin/discovery" className="btn btn-ghost btn-sm">Discovery</Link>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-hero">
          <div>
            <div className="admin-kicker">Phase 2 — Listing Performance Intelligence</div>
            <h1>What actually performs on eBay</h1>
            <p>
              The learning loop tracks real outcomes — days-to-sale, watchers, sell-through, realized profit,
              cancels & refunds — and feeds them back into sourcing. Fast-sellers raise their ASIN&apos;s sourcing
              priority; stale/refunded products lower it; niches with proven sell-through get more allocation.
            </p>
          </div>
          <div className="admin-status-card admin-status-healthy">
            <span>Learning loop</span>
            <strong>Active</strong>
            <p>Hourly outcome pull + rescore</p>
            <small>Updated {new Date(data.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
          </div>
        </div>

        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div>
              <span>Actions</span>
              <h2>Recompute learning loop</h2>
            </div>
            <button className="btn btn-primary btn-sm" onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Rescoring...' : 'Pull sales + rescore'}
            </button>
          </div>
          {msg && (
            <div
              style={{
                marginTop: '10px', padding: '10px 12px', borderRadius: '8px', fontSize: '13px',
                border: `1px solid ${msg.tone === 'error' ? '#ef4444' : msg.tone === 'success' ? '#22c55e' : '#60a5fa'}`,
                background: msg.tone === 'error' ? 'rgba(239,68,68,0.08)' : msg.tone === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(96,165,250,0.08)',
              }}
            >
              {msg.message}
            </div>
          )}
        </section>

        {/* Best niches */}
        <PerfPanel title="Best niches by sell-through" subtitle="Min 5 listings in 30d — these deserve more sourcing">
          <table className="admin-table">
            <thead>
              <tr><th>Niche</th><th>Sell-through</th><th>Sold/Listed</th><th>Avg days to sale</th><th>Profit 30d</th><th>Boost</th></tr>
            </thead>
            <tbody>
              {data.bestNiches.length === 0 && <tr><td colSpan={6} style={{ opacity: 0.6 }}>Not enough sales data yet.</td></tr>}
              {data.bestNiches.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className="admin-pill admin-pill-good">{formatPct(n.sell_through_rate)}</span></td>
                  <td>{formatNumber(n.sold_30d)}/{formatNumber(n.listed_30d)}</td>
                  <td>{n.avg_days_to_sale != null ? `${num(n.avg_days_to_sale).toFixed(1)}d` : '—'}</td>
                  <td>{formatMoney(n.realized_profit_30d)}</td>
                  <td>{num(n.outcome_multiplier).toFixed(2)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PerfPanel>

        {/* Worst niches */}
        <PerfPanel title="Worst niches — list but don't sell" subtitle="Min 8 listings, low sell-through — candidates to decay/retire">
          <table className="admin-table">
            <thead>
              <tr><th>Niche</th><th>Sell-through</th><th>Sold/Listed</th><th>Avg days to sale</th><th>Sourcing weight</th></tr>
            </thead>
            <tbody>
              {data.worstNiches.length === 0 && <tr><td colSpan={5} style={{ opacity: 0.6 }}>Not enough data.</td></tr>}
              {data.worstNiches.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className={`admin-pill admin-pill-${num(n.sell_through_rate) < 0.1 ? 'bad' : 'watch'}`}>{formatPct(n.sell_through_rate)}</span></td>
                  <td>{formatNumber(n.sold_30d)}/{formatNumber(n.listed_30d)}</td>
                  <td>{n.avg_days_to_sale != null ? `${num(n.avg_days_to_sale).toFixed(1)}d` : '—'}</td>
                  <td>{num(n.outcome_multiplier).toFixed(2)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PerfPanel>

        {/* Fastest listings */}
        <PerfPanel title="Fastest-moving listings (30d)" subtitle="Sold quickest — clone these patterns">
          <table className="admin-table">
            <thead>
              <tr><th>Product</th><th>Niche</th><th>Days to sale</th><th>Sale price</th><th>Profit</th><th>Watchers</th></tr>
            </thead>
            <tbody>
              {data.fastestListings.length === 0 && <tr><td colSpan={6} style={{ opacity: 0.6 }}>No sales recorded yet.</td></tr>}
              {data.fastestListings.map((l) => (
                <tr key={l.asin}>
                  <td title={l.title}>{truncate(l.title)}</td>
                  <td>{l.niche}</td>
                  <td><span className="admin-pill admin-pill-good">{l.days_to_sale != null ? `${num(l.days_to_sale).toFixed(1)}d` : '—'}</span></td>
                  <td>{formatMoney(l.sale_price)}</td>
                  <td>{l.realized_profit != null ? formatMoney(l.realized_profit) : '—'}</td>
                  <td>{formatNumber(l.watch_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PerfPanel>

        {/* Top products */}
        <PerfPanel title="Top products by performance score" subtitle="Velocity + profit + engagement, refund/stall penalized">
          <table className="admin-table">
            <thead>
              <tr><th>Product</th><th>Niche</th><th>Score</th><th>Profit</th><th>Watch/Hits</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.topProducts.length === 0 && <tr><td colSpan={6} style={{ opacity: 0.6 }}>No scored listings yet.</td></tr>}
              {data.topProducts.map((l) => (
                <tr key={l.asin}>
                  <td title={l.title}>{truncate(l.title)}</td>
                  <td>{l.niche}</td>
                  <td><strong>{l.performance_score != null ? Math.round(num(l.performance_score)) : '—'}</strong></td>
                  <td>{l.realized_profit != null ? formatMoney(l.realized_profit) : '—'}</td>
                  <td>{formatNumber(l.watch_count)} / {formatNumber(l.hit_count)}</td>
                  <td>{l.sold_at ? <span className="admin-pill admin-pill-good">Sold</span> : <span className="admin-pill admin-pill-watch">Live</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PerfPanel>

        {/* Stale listings */}
        <PerfPanel title="Worst stale listings" subtitle="Active >30d, unsold, low engagement — end or reprice these">
          <table className="admin-table">
            <thead>
              <tr><th>Product</th><th>Niche</th><th>Age</th><th>Watchers</th><th>Reductions</th><th>Score</th></tr>
            </thead>
            <tbody>
              {data.staleListings.length === 0 && <tr><td colSpan={6} style={{ opacity: 0.6 }}>No stale listings — nice.</td></tr>}
              {data.staleListings.map((l) => (
                <tr key={l.asin}>
                  <td title={l.title}>{truncate(l.title)}</td>
                  <td>{l.niche}</td>
                  <td><span className="admin-pill admin-pill-bad">{formatNumber(l.age_days)}d</span></td>
                  <td>{formatNumber(l.watch_count)}</td>
                  <td>{formatNumber(l.reduction_count)}</td>
                  <td>{l.performance_score != null ? Math.round(num(l.performance_score)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PerfPanel>

        {/* High refund/cancel niches */}
        <PerfPanel title="Highest refund / cancel niches" subtitle="These erode profit — investigate sourcing quality">
          <table className="admin-table">
            <thead>
              <tr><th>Niche</th><th>Cancel rate</th><th>Refund rate</th><th>Sold 30d</th></tr>
            </thead>
            <tbody>
              {data.highRefundNiches.length === 0 && <tr><td colSpan={4} style={{ opacity: 0.6 }}>No refunds or cancels recorded.</td></tr>}
              {data.highRefundNiches.map((n) => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td><span className={`admin-pill admin-pill-${num(n.cancel_rate) > 0.1 ? 'bad' : 'watch'}`}>{formatPct(n.cancel_rate)}</span></td>
                  <td><span className={`admin-pill admin-pill-${num(n.refund_rate) > 0.08 ? 'bad' : 'watch'}`}>{formatPct(n.refund_rate)}</span></td>
                  <td>{formatNumber(n.sold_30d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PerfPanel>

        <div className="admin-subtle-line" style={{ marginTop: '16px' }}>
          Outcome data is pulled hourly from eBay (sales via Sell API, engagement via Trading API GetItem — quota-gated).
          Sourcing scores update automatically: fast-sellers gain priority, stale/refunded products lose it.
        </div>
      </section>
    </main>
  )
}

function PerfPanel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="admin-panel" style={{ marginTop: '16px' }}>
      <div className="admin-panel-head">
        <div>
          <span>{subtitle}</span>
          <h2>{title}</h2>
        </div>
      </div>
      <div className="admin-table-wrap" style={{ marginTop: '10px' }}>
        {children}
      </div>
    </section>
  )
}
