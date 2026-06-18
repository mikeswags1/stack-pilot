'use client'

import { useCallback, useEffect, useState } from 'react'

type Account = {
  id: number; email: string; plan: string; status: string; trial_used: number
  active_listings: number; sales_30d: number; created_at: string
}
type Overview = {
  generatedAt: string
  accounts: Account[]
  pool: { active: number; ready: number; money_band: number }
  topNiches: Array<{ niche: string; ready: number }>
  money: { active_listings: number; sold_30d: number; revenue_30d: number; profit_30d: number }
  health: {
    sourceAgentLastRun: string | null; sourceAgentLastStatus: string | null
    lastRepriceAt: string | null; ebayCallsToday: number; ebayCallsFailedToday: number
    listingFailuresToday: number
  }
}

const card: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 14, padding: '18px 20px',
}
const label: React.CSSProperties = { fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: '#7f93a8' }
const big: React.CSSProperties = { fontSize: 30, fontWeight: 800, color: '#e8eef5', marginTop: 6 }

function ago(iso: string | null, nowMs: number) {
  if (!iso) return 'never'
  const mins = Math.round((nowMs - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

export default function OwnerOverview() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nowMs, setNowMs] = useState(0)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/admin/overview', { cache: 'no-store' })
      if (res.status === 401) { setError('Not authorized — sign in with your admin account.'); return }
      if (!res.ok) { setError(`Failed to load (${res.status})`); return }
      const json = await res.json()
      setData(json.data ?? json)
      setNowMs(Date.now())
    } catch {
      setError('Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const sourceHealthy = Boolean(
    data?.health.sourceAgentLastStatus === 'success'
    && data?.health.sourceAgentLastRun
    && (nowMs - new Date(data.health.sourceAgentLastRun).getTime()) < 3 * 3600 * 1000
  )

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '40px 24px 80px', color: '#cdd8e3', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <h1 style={{ fontSize: 30, fontWeight: 800, color: '#fff', margin: 0 }}>Owner Overview</h1>
        <button onClick={() => void load()} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.2)', color: '#9fb1c4', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 13 }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: '#6b7d90', marginBottom: 28 }}>
        {data ? `Updated ${ago(data.generatedAt, nowMs)} · exactly what's happening, nothing else` : 'Loading your business at a glance…'}
      </div>

      {error && <div style={{ ...card, borderColor: 'rgba(232,63,80,0.4)', color: '#ff9aa6' }}>{error}</div>}

      {data && (
        <>
          {/* ── The numbers that matter ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 30 }}>
            <div style={card}><div style={label}>Active Listings</div><div style={big}>{data.money.active_listings.toLocaleString()}</div></div>
            <div style={card}><div style={label}>Sales (30 days)</div><div style={big}>{data.money.sold_30d}</div></div>
            <div style={card}><div style={label}>Revenue (30d)</div><div style={big}>${data.money.revenue_30d.toFixed(0)}</div></div>
            <div style={card}><div style={label}>Profit (30d)</div><div style={{ ...big, color: data.money.profit_30d >= 0 ? '#5fd39a' : '#ff9aa6' }}>${data.money.profit_30d.toFixed(0)}</div></div>
            <div style={card}><div style={label}>Ready to List</div><div style={{ ...big, color: '#56b6e0' }}>{data.pool.ready.toLocaleString()}</div></div>
          </div>

          {/* ── Accounts ── */}
          <h2 style={{ fontSize: 18, color: '#fff', marginBottom: 12 }}>Accounts ({data.accounts.length})</h2>
          <div style={{ ...card, padding: 0, overflow: 'hidden', marginBottom: 30 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#7f93a8', textAlign: 'left' }}>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Account</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Plan</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: 'right' }}>Active Listings</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: 'right' }}>Sales (30d)</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => (
                  <tr key={a.id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ padding: '12px 16px', color: '#dfe8f1' }}>{a.email}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
                        background: a.plan === 'pro' ? 'rgba(95,211,154,0.15)' : 'rgba(255,255,255,0.07)',
                        color: a.plan === 'pro' ? '#5fd39a' : '#9fb1c4' }}>{a.plan.toUpperCase()}</span>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', color: '#dfe8f1' }}>{a.active_listings.toLocaleString()}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', color: a.sales_30d > 0 ? '#5fd39a' : '#6b7d90' }}>{a.sales_30d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Source pool + Health side by side ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 20 }}>
            <div style={card}>
              <h2 style={{ fontSize: 18, color: '#fff', margin: '0 0 14px' }}>Source Pool</h2>
              <Row k="Active products" v={data.pool.active.toLocaleString()} />
              <Row k="Ready to list now" v={data.pool.ready.toLocaleString()} accent="#56b6e0" />
              <Row k="In $25–60 money band" v={data.pool.money_band.toLocaleString()} />
              <div style={{ ...label, marginTop: 16, marginBottom: 8 }}>Top niches (ready)</div>
              {data.topNiches.map((n) => (
                <div key={n.niche} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', color: '#b8c6d4' }}>
                  <span>{n.niche}</span><span style={{ color: '#8aa0b4' }}>{n.ready}</span>
                </div>
              ))}
            </div>

            <div style={card}>
              <h2 style={{ fontSize: 18, color: '#fff', margin: '0 0 14px' }}>System Health</h2>
              <Row k="Sourcing engine" v={sourceHealthy ? `✅ healthy · ${ago(data.health.sourceAgentLastRun, nowMs)}` : `⚠️ check · ${ago(data.health.sourceAgentLastRun, nowMs)}`} accent={sourceHealthy ? '#5fd39a' : '#ffcf6b'} />
              <Row k="Last reprice run" v={ago(data.health.lastRepriceAt, nowMs)} />
              <Row k="eBay calls today" v={`${data.health.ebayCallsToday} (${data.health.ebayCallsFailedToday} failed)`} accent={data.health.ebayCallsFailedToday > 200 ? '#ffcf6b' : undefined} />
              <Row k="Listing failures today" v={String(data.health.listingFailuresToday)} accent={data.health.listingFailuresToday > 20 ? '#ffcf6b' : undefined} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ k, v, accent }: { k: string; v: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ fontSize: 13, color: '#9fb1c4' }}>{k}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: accent || '#e8eef5' }}>{v}</span>
    </div>
  )
}
