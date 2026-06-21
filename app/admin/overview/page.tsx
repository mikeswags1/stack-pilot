// SERVER-RENDERED Owner Overview. No 'use client', no hooks, no client fetch —
// the HTML is built on the server with the numbers already in it, so it cannot
// blank out from a client-side crash (the failure mode the client version had).
// Refresh the browser for live numbers (force-dynamic = always fresh).
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { queryRows } from '@/lib/db'

export const dynamic = 'force-dynamic'

const ADMIN_EMAILS = ['msawaged12@gmail.com', 'mikeswags1@gmail.com']

const bg = '#0a1420'
const card: React.CSSProperties = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: '18px 20px' }
const lbl: React.CSSProperties = { fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: '#7f93a8' }
const num: React.CSSProperties = { fontSize: 28, fontWeight: 800, color: '#e8eef5', marginTop: 6 }
const td: React.CSSProperties = { padding: '11px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }
const th: React.CSSProperties = { padding: '11px 16px', fontWeight: 600, color: '#7f93a8', textAlign: 'left' }

export default async function OwnerOverview() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.email || !ADMIN_EMAILS.includes(session.user.email)) {
    return (
      <main style={{ minHeight: '100vh', background: bg, color: '#e8eef5', fontFamily: 'system-ui, sans-serif', padding: 48 }}>
        <h1 style={{ color: '#fff' }}>Owner Overview</h1>
        <p style={{ color: '#ff9aa6' }}>Not authorized. Log in with your admin account (mikeswags1@gmail.com), then reload this page.</p>
      </main>
    )
  }

  const accounts = await queryRows<{ id: number; email: string; plan: string; active_listings: number; sales_30d: number }>`
    SELECT u.id, u.email, COALESCE(s.plan,'trial') AS plan,
      (SELECT COUNT(*) FROM listed_asins la WHERE la.user_id = u.id AND la.ended_at IS NULL)::int AS active_listings,
      (SELECT COUNT(*) FROM listed_asins la WHERE la.user_id = u.id AND la.sold_at > NOW() - INTERVAL '30 days')::int AS sales_30d
    FROM users u LEFT JOIN user_subscriptions s ON s.user_id = u.id
    ORDER BY active_listings DESC, u.created_at ASC`.catch(() => [])

  const poolActive = await queryRows<{ n: number }>`SELECT COUNT(*)::int AS n FROM product_source_items WHERE active = TRUE`.catch(() => [{ n: 0 }])
  const poolReady = await queryRows<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM product_source_items psi LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin)=UPPER(psi.asin)
    WHERE psi.active = TRUE AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality,'candidate') <> 'reject' AND COALESCE(apc.available, TRUE) <> FALSE
      AND apc.fast_fulfillment IS DISTINCT FROM FALSE AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
      AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)`.catch(() => [{ n: 0 }])
  const poolBand = await queryRows<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM product_source_items psi LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin)=UPPER(psi.asin)
    WHERE psi.active = TRUE AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality,'candidate') <> 'reject' AND COALESCE(apc.available, TRUE) <> FALSE
      AND apc.fast_fulfillment IS DISTINCT FROM FALSE AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
      AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
      AND psi.amazon_price BETWEEN 25 AND 60`.catch(() => [{ n: 0 }])
  const freshReady = await queryRows<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM product_source_items psi LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin)=UPPER(psi.asin)
    WHERE psi.active = TRUE AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
      AND COALESCE(psi.source_quality,'candidate') <> 'reject' AND COALESCE(apc.available, TRUE) <> FALSE
      AND apc.fast_fulfillment IS DISTINCT FROM FALSE AND (apc.delivery_days_max IS NULL OR apc.delivery_days_max <= 8)
      AND (psi.ebay_competitor_count IS NULL OR psi.ebay_competitor_count <= 50)
      AND (psi.ebay_competitor_min_price IS NULL OR psi.amazon_price < psi.ebay_competitor_min_price * 1.65)
      AND apc.asin IS NOT NULL AND jsonb_typeof(apc.images) = 'array' AND jsonb_array_length(apc.images) >= 2
      AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
      AND psi.first_seen_at > NOW() - INTERVAL '7 days'`.catch(() => [{ n: 0 }])

  const money = await queryRows<{ active_listings: number; sold_30d: number; revenue_30d: number; profit_30d: number }>`
    SELECT (SELECT COUNT(*) FROM listed_asins WHERE ended_at IS NULL)::int AS active_listings,
      (SELECT COUNT(*) FROM listed_asins WHERE sold_at > NOW() - INTERVAL '30 days')::int AS sold_30d,
      COALESCE((SELECT SUM(sale_price) FROM listed_asins WHERE sold_at > NOW() - INTERVAL '30 days'),0)::float AS revenue_30d,
      COALESCE((SELECT SUM(realized_profit) FROM listed_asins WHERE sold_at > NOW() - INTERVAL '30 days'),0)::float AS profit_30d`.catch(() => [{ active_listings: 0, sold_30d: 0, revenue_30d: 0, profit_30d: 0 }])

  const sa = await queryRows<{ status: string; mins_ago: number }>`SELECT status, ROUND(EXTRACT(EPOCH FROM (NOW() - created_at))/60)::int AS mins_ago FROM source_agent_runs ORDER BY created_at DESC LIMIT 1`.catch(() => [])
  const ebay = await queryRows<{ n: number; failed: number }>`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE NOT success)::int AS failed FROM api_usage_log WHERE provider='ebay' AND created_at > NOW() - INTERVAL '24 hours'`.catch(() => [{ n: 0, failed: 0 }])
  const inflow7d = await queryRows<{ n: number }>`SELECT COUNT(*)::int AS n FROM product_source_items WHERE first_seen_at > NOW() - INTERVAL '7 days'`.catch(() => [{ n: 0 }])

  const m = money[0]
  const saRun = sa[0]
  const saAgo = saRun ? Number(saRun.mins_ago) : null
  const saHealthy = saRun?.status === 'success' && saAgo !== null && saAgo < 180

  return (
    <main style={{ minHeight: '100vh', background: bg, color: '#cdd8e3', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '40px 24px 80px' }}>
        <h1 style={{ fontSize: 30, fontWeight: 800, color: '#fff', margin: 0 }}>Owner Overview</h1>
        <div style={{ fontSize: 12, color: '#6b7d90', margin: '6px 0 28px' }}>Live · refresh the page to update · server-rendered (can&apos;t blank out)</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 14, marginBottom: 30 }}>
          <div style={card}><div style={lbl}>Active Listings</div><div style={num}>{m.active_listings.toLocaleString()}</div></div>
          <div style={card}><div style={lbl}>Sales (30d)</div><div style={num}>{m.sold_30d}</div></div>
          <div style={card}><div style={lbl}>Revenue (30d)</div><div style={num}>${m.revenue_30d.toFixed(0)}</div></div>
          <div style={card}><div style={lbl}>Profit (30d)</div><div style={{ ...num, color: m.profit_30d >= 0 ? '#5fd39a' : '#ff9aa6' }}>${m.profit_30d.toFixed(0)}</div></div>
          <div style={card}><div style={lbl}>Ready to List</div><div style={{ ...num, color: '#56b6e0' }}>{(poolReady[0]?.n ?? 0).toLocaleString()}</div></div>
        </div>

        <h2 style={{ fontSize: 18, color: '#fff', marginBottom: 12 }}>Accounts ({accounts.length})</h2>
        <div style={{ ...card, padding: 0, overflow: 'hidden', marginBottom: 30 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th style={th}>Account</th><th style={th}>Plan</th><th style={{ ...th, textAlign: 'right' }}>Active Listings</th><th style={{ ...th, textAlign: 'right' }}>Sales (30d)</th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...td, color: '#dfe8f1' }}>{a.email}</td>
                  <td style={td}><span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: a.plan === 'pro' ? 'rgba(95,211,154,0.15)' : 'rgba(255,255,255,0.07)', color: a.plan === 'pro' ? '#5fd39a' : '#9fb1c4' }}>{a.plan.toUpperCase()}</span></td>
                  <td style={{ ...td, textAlign: 'right', color: '#dfe8f1' }}>{a.active_listings.toLocaleString()}</td>
                  <td style={{ ...td, textAlign: 'right', color: a.sales_30d > 0 ? '#5fd39a' : '#6b7d90' }}>{a.sales_30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 20 }}>
          <div style={card}>
            <h2 style={{ fontSize: 18, color: '#fff', margin: '0 0 14px' }}>Source Pool</h2>
            <RowKV k="Active products" v={(poolActive[0]?.n ?? 0).toLocaleString()} />
            <RowKV k="Ready to list now" v={(poolReady[0]?.n ?? 0).toLocaleString()} c="#56b6e0" />
            <RowKV k="In $25–60 money band" v={(poolBand[0]?.n ?? 0).toLocaleString()} />
            <RowKV k="New ready (last 7d)" v={(freshReady[0]?.n ?? 0).toLocaleString()} c="#5fd39a" />
            <RowKV k="Total discovered (7d)" v={(inflow7d[0]?.n ?? 0).toLocaleString()} />
          </div>
          <div style={card}>
            <h2 style={{ fontSize: 18, color: '#fff', margin: '0 0 14px' }}>System Health</h2>
            <RowKV k="Sourcing engine" v={saRun ? `${saHealthy ? '✅ healthy' : '⚠️ check'} · ${saAgo}m ago` : 'no runs yet'} c={saHealthy ? '#5fd39a' : '#ffcf6b'} />
            <RowKV k="eBay calls today" v={`${ebay[0]?.n ?? 0} (${ebay[0]?.failed ?? 0} failed)`} c={(ebay[0]?.failed ?? 0) > 200 ? '#ffcf6b' : undefined} />
          </div>
        </div>
      </div>
    </main>
  )
}

function RowKV({ k, v, c }: { k: string; v: string; c?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <span style={{ fontSize: 13, color: '#9fb1c4' }}>{k}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: c || '#e8eef5' }}>{v}</span>
    </div>
  )
}
