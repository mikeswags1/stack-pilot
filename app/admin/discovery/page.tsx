'use client'

// Phase 4 — Scalable discovery admin view.
//
// Shows the inventory funnel breadth: total ASIN universe, raw→enriched→validated counts,
// per-depth analytics (candidates / enrichment / list-ready / quality by recursion depth),
// source diversity, evergreen split, and graph edges. Plus admin controls for depth, budgets,
// confidence thresholds, and evergreen aggressiveness.

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

type Settings = {
  enabled: boolean
  maxDepth: number
  branchBudget: number
  nodeBudget: number
  enrichmentBudget: number
  confidenceFloor: number
  evergreenAggressiveness: number
  reactivationBatch: number
}

type DepthRow = {
  depth: number
  candidates: number
  enriched: number
  list_ready: number
  avg_roi: number | null
  avg_quality: number | null
}

type Funnel = {
  discovered: number
  enriched: number
  listReady: number
  listed: number
  discoveredToEnriched: number
  enrichedToValidated: number
  validatedToListed: number
}

type Payload = {
  generatedAt: string
  universe: Record<string, number>
  freshness: Record<string, number>
  sources: Array<{ source: string; n: number }>
  depthAnalytics: DepthRow[]
  evergreenSplit: Record<string, number>
  edges: Record<string, number>
  funnel: Funnel
  enrichmentQuotaState: 'ok' | 'warn' | 'block'
  settings: Settings
}

function fmt(v: unknown) {
  const n = typeof v === 'number' ? v : Number(v || 0)
  return new Intl.NumberFormat('en-US').format(Math.round(Number.isFinite(n) ? n : 0))
}

export default function AdminDiscoveryPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'info' | 'success' | 'error'; message: string } | null>(null)
  const [form, setForm] = useState<Settings | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/admin/discovery', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setData(json as Payload)
      setForm((json as Payload).settings)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load discovery data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'loading') return
    if (status === 'unauthenticated') { router.replace('/login?next=/admin/discovery'); return }
    load()
  }, [status, router, load])

  const runAction = async (action: string, label: string) => {
    setBusy(action)
    setMsg({ tone: 'info', message: `${label}...` })
    try {
      const res = await fetch('/api/admin/discovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      const d = json.discovery, e = json.enrichment, r = json.reactivation
      const summary = json.skipped === 'graph_discovery_disabled' ? 'Graph discovery is disabled — enable it in controls first.'
        : d ? `Discovered ${d.candidatesWritten ?? 0} candidates (${d.nodesExpanded ?? 0} nodes, ${d.weakBranchesTerminated ?? 0} weak branches cut, ${d.scrapesUsed ?? 0}/${d.scrapeCeiling ?? 0} scrapes used).`
        : e ? `Enriched ${e.enriched ?? 0}, promoted ${e.promoted ?? 0}${e.skipped ? ` (skipped: ${e.skipped})` : ''}.`
        : r ? `Revalidated ${r.revalidated ?? 0}, reactivated ${r.reactivated ?? 0}.`
        : 'Done.'
      setMsg({ tone: 'success', message: summary })
      await load()
    } catch (err) {
      setMsg({ tone: 'error', message: err instanceof Error ? err.message : 'Action failed.' })
    } finally {
      setBusy(null)
    }
  }

  const saveSettings = async () => {
    if (!form) return
    setBusy('settings')
    setMsg({ tone: 'info', message: 'Saving controls...' })
    try {
      const res = await fetch('/api/admin/discovery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settings', settings: form }),
      })
      const json = await res.json()
      if (!res.ok || json?.ok === false) throw new Error(json?.error?.message || `Request failed (${res.status})`)
      setMsg({ tone: 'success', message: 'Controls saved.' })
      setForm(json.settings)
      await load()
    } catch (err) {
      setMsg({ tone: 'error', message: err instanceof Error ? err.message : 'Save failed.' })
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <div className="admin-loading">Loading discovery intelligence...</div>
  if (error || !data) return <div className="admin-loading admin-loading-error">{error || 'Access denied.'}</div>

  const u = data.universe
  const f = data.freshness
  const ever = data.evergreenSplit
  const evergreenTotal = (Number(ever.evergreen) || 0) + (Number(ever.seasonal) || 0)
  const evergreenPct = evergreenTotal > 0 ? Math.round((Number(ever.evergreen) || 0) / evergreenTotal * 100) : 0

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <Link href="/" className="home-brand" aria-label="StackPilot home">Stack<span>Pilot</span></Link>
        <div className="admin-topbar-actions">
          <span>{session?.user?.email}</span>
          <Link href="/admin" className="btn btn-ghost btn-sm">Admin</Link>
          <Link href="/admin/health" className="btn btn-ghost btn-sm">Health</Link>
          <Link href="/admin/niches" className="btn btn-ghost btn-sm">Niches</Link>
          <Link href="/admin/performance" className="btn btn-ghost btn-sm">Performance</Link>
          <Link href="/admin/market" className="btn btn-ghost btn-sm">Market</Link>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
        </div>
      </header>

      <section className="admin-shell">
        <div className="admin-hero">
          <div>
            <div className="admin-kicker">Phase 4 — Scalable Inventory Discovery</div>
            <h1>Massive discovery, selective enrichment</h1>
            <p>
              Cheap recursive graph discovery floods the ASIN universe; only the strongest raw candidates
              get quota-gated enrichment, then full preflight before list-ready. Funnel:{' '}
              <strong>discover → filter → dedupe → score → enrich → validate → list-ready</strong>.
            </p>
          </div>
          <div className="admin-status-card admin-status-healthy">
            <span>ASIN universe</span>
            <strong>{fmt(u.total_universe)}</strong>
            <p>{fmt(u.active)} active · {fmt(u.dormant)} dormant · {fmt(u.rejected)} rejected</p>
            <small>Updated {new Date(data.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>
          </div>
        </div>

        <div className="admin-metrics-grid" style={{ marginTop: '16px' }}>
          <Metric label="Raw candidates" value={fmt(u.raw_candidates)} detail="discovered, not yet enriched" />
          <Metric label="Enriched" value={fmt(u.enriched)} detail="full detail pulled" />
          <Metric label="Validated / list-ready" value={fmt(u.validated)} detail="passed full preflight" />
          <Metric label="New candidates (24h)" value={fmt(f.new_24h)} detail={`${fmt(f.new_7d)} in 7d · ${fmt(f.reactivated_24h)} reactivated`} />
          <Metric label="Evergreen share" value={`${evergreenPct}%`} detail={`${fmt(ever.evergreen)} evergreen · ${fmt(ever.seasonal)} seasonal`} />
          <Metric label="Graph edges" value={fmt(data.edges.total_edges)} detail={`${fmt(data.edges.edges_24h)} new in 24h`} />
          <Metric label="Failed enrichment" value={fmt(u.enrich_failed)} detail="gave up after 2 attempts" />
          <Metric label="Duplicate-suppressed" value={fmt(u.dup_suppressed)} detail="non-best cluster members" />
          <Metric
            label="Enrichment quota"
            value={data.enrichmentQuotaState === 'ok' ? 'OK' : data.enrichmentQuotaState === 'warn' ? 'THROTTLED' : 'BLOCKED'}
            detail={data.enrichmentQuotaState === 'ok' ? 'RapidAPI within budget' : 'RapidAPI gate active — enrichment paused'}
          />
        </div>

        {/* Conversion funnel — the metric that matters: are validated/list-ready products growing? */}
        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head">
            <div><span>Conversion funnel</span><h2>Discovered → enriched → validated → listed</h2></div>
          </div>
          <div className="admin-table-wrap" style={{ marginTop: '10px' }}>
            <table className="admin-table">
              <thead><tr><th>Stage</th><th>Count</th><th>Conversion from prior stage</th></tr></thead>
              <tbody>
                <tr><td>Discovered (viable candidates)</td><td><strong>{fmt(data.funnel.discovered)}</strong></td><td>—</td></tr>
                <tr><td>Enriched (cache + 2+ images)</td><td><strong>{fmt(data.funnel.enriched)}</strong></td><td>{Math.round(data.funnel.discoveredToEnriched * 100)}% of discovered</td></tr>
                <tr><td>Validated / list-ready</td><td><strong>{fmt(data.funnel.listReady)}</strong></td><td>{Math.round(data.funnel.enrichedToValidated * 100)}% of enriched</td></tr>
                <tr><td>Listed on eBay</td><td><strong>{fmt(data.funnel.listed)}</strong></td><td>{Math.round(data.funnel.validatedToListed * 100)}% of list-ready</td></tr>
              </tbody>
            </table>
          </div>
          <div className="admin-subtle-line" style={{ marginTop: '10px' }}>
            Raw candidates are <strong>never</strong> list-ready until enriched (cache + 2+ images) and validated. The
            list-ready/Product Listing pool only draws from the validated stage — watch it grow as enrichment runs.
          </div>
        </section>

        {/* Controls */}
        {form && (
          <section className="admin-panel" style={{ marginTop: '16px' }}>
            <div className="admin-panel-head">
              <div><span>Controls</span><h2>Discovery & enrichment tuning</h2></div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => runAction('discover', 'Running discovery')}>{busy === 'discover' ? 'Discovering...' : 'Run discovery'}</button>
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => runAction('enrich', 'Enriching top candidates')}>{busy === 'enrich' ? 'Enriching...' : 'Run enrichment'}</button>
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => runAction('reactivate', 'Reactivating dormant')}>{busy === 'reactivate' ? 'Reactivating...' : 'Reactivate dormant'}</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginTop: '12px' }}>
              <Control label="Enabled" type="toggle" value={form.enabled} onChange={(v) => setForm({ ...form, enabled: v as boolean })} />
              <Control label="Max recursion depth" type="number" value={form.maxDepth} min={1} max={4} onChange={(v) => setForm({ ...form, maxDepth: v as number })} />
              <Control label="Branch budget / node" type="number" value={form.branchBudget} min={2} max={25} onChange={(v) => setForm({ ...form, branchBudget: v as number })} />
              <Control label="Node budget / run" type="number" value={form.nodeBudget} min={5} max={150} onChange={(v) => setForm({ ...form, nodeBudget: v as number })} />
              <Control label="Enrichment budget / run" type="number" value={form.enrichmentBudget} min={0} max={100} onChange={(v) => setForm({ ...form, enrichmentBudget: v as number })} />
              <Control label="Confidence floor" type="number" step={0.01} value={form.confidenceFloor} min={0.05} max={0.6} onChange={(v) => setForm({ ...form, confidenceFloor: v as number })} />
              <Control label="Evergreen aggressiveness" type="number" step={0.1} value={form.evergreenAggressiveness} min={0.5} max={2} onChange={(v) => setForm({ ...form, evergreenAggressiveness: v as number })} />
              <Control label="Reactivation batch / run" type="number" value={form.reactivationBatch} min={0} max={200} onChange={(v) => setForm({ ...form, reactivationBatch: v as number })} />
            </div>
            <div style={{ marginTop: '12px' }}>
              <button className="btn btn-primary btn-sm" disabled={busy === 'settings'} onClick={saveSettings}>
                {busy === 'settings' ? 'Saving...' : 'Save controls'}
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
        )}

        {/* Per-depth analytics */}
        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head"><div><span>Per-depth analytics</span><h2>Quality by recursion depth</h2></div></div>
          <div className="admin-table-wrap" style={{ marginTop: '10px' }}>
            <table className="admin-table">
              <thead><tr><th>Depth</th><th>Candidates</th><th>Enriched</th><th>List-ready</th><th>Enrich rate</th><th>Avg ROI</th><th>Avg quality</th></tr></thead>
              <tbody>
                {data.depthAnalytics.length === 0 && <tr><td colSpan={7} style={{ opacity: 0.6 }}>No discovery data yet — run discovery.</td></tr>}
                {data.depthAnalytics.map((d) => {
                  const enrichRate = d.candidates > 0 ? Math.round((d.enriched / d.candidates) * 100) : 0
                  return (
                    <tr key={d.depth}>
                      <td><strong>{d.depth === 0 ? 'Seed (0)' : d.depth}</strong></td>
                      <td>{fmt(d.candidates)}</td>
                      <td>{fmt(d.enriched)}</td>
                      <td>{fmt(d.list_ready)}</td>
                      <td>{enrichRate}%</td>
                      <td>{d.avg_roi != null ? `${Math.round(Number(d.avg_roi))}%` : '—'}</td>
                      <td>{d.avg_quality != null ? Math.round(Number(d.avg_quality)) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="admin-subtle-line" style={{ marginTop: '10px' }}>
            Depth 0 = proven seeds. Each hop applies confidence decay; branches below the confidence floor terminate.
            Watch enrich-rate + quality by depth to tune how deep recursion should go.
          </div>
        </section>

        {/* Source diversity */}
        <section className="admin-panel" style={{ marginTop: '16px' }}>
          <div className="admin-panel-head"><div><span>Source diversity</span><h2>Active pool by discovery source</h2></div></div>
          <div className="admin-table-wrap" style={{ marginTop: '10px' }}>
            <table className="admin-table">
              <thead><tr><th>Discovery source</th><th>Active products</th></tr></thead>
              <tbody>
                {data.sources.length === 0 && <tr><td colSpan={2} style={{ opacity: 0.6 }}>No data yet.</td></tr>}
                {data.sources.map((s) => (
                  <tr key={s.source}><td><code>{s.source}</code></td><td>{fmt(s.n)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="admin-metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
  )
}

function Control({ label, type, value, onChange, min, max, step }: {
  label: string
  type: 'number' | 'toggle'
  value: number | boolean
  onChange: (v: number | boolean) => void
  min?: number
  max?: number
  step?: number
}) {
  return (
    <div className="admin-small-stat" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <span>{label}</span>
      {type === 'toggle' ? (
        <button
          className={`btn btn-sm ${value ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onChange(!value)}
        >{value ? 'On' : 'Off'}</button>
      ) : (
        <input
          type="number"
          value={String(value)}
          min={min}
          max={max}
          step={step || 1}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(125,211,252,0.2)', background: 'rgba(255,255,255,0.02)', color: 'inherit', fontSize: '15px', width: '100%' }}
        />
      )}
    </div>
  )
}
