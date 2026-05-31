'use client'

// One-off quick-list tool for 4 specific products with a buyer interested.
// Pre-loaded ASINs + recommended prices, click "List Now" per product or
// "List All 4" to fire them sequentially. No bulk-pricing-engine logic —
// just direct POSTs to the existing /api/ebay/list-product route.

import { useState } from 'react'
import Link from 'next/link'

type Product = {
  id: number
  asin: string
  title: string
  amazonCost: number
  competitorMin: number
  recommendedPrice: number
}

const PRODUCTS: Product[] = [
  {
    id: 1,
    asin: 'B07MMZGZV8',
    title: 'KastKing Megatron Spinning Reel — Freshwater & Saltwater',
    amazonCost: 53.54,
    competitorMin: 37.18,
    recommendedPrice: 77.00,
  },
  {
    id: 2,
    asin: 'B079GJ6K2R',
    title: 'Sougayilang Telescopic Rod + Reel Combo (with carrier bag)',
    amazonCost: 47.44,
    competitorMin: 39.99,
    recommendedPrice: 68.00,
  },
  {
    id: 3,
    asin: 'B07VWHDJ3T',
    title: 'KastKing Megatron Titanium Telescopic Rod (IM7 Graphite)',
    amazonCost: 69.99,
    competitorMin: 31.19,
    recommendedPrice: 99.00,
  },
  {
    id: 4,
    asin: 'B0G3PV5629',
    title: 'KastKing Megatron Titanium Telescopic Rod (travel variant)',
    amazonCost: 64.99,
    competitorMin: 28.79,
    recommendedPrice: 93.00,
  },
]

type Status = { state: 'idle' | 'listing' | 'success' | 'error'; message?: string; listingId?: string }

export default function QuickListPage() {
  const [prices, setPrices] = useState<Record<number, number>>(
    Object.fromEntries(PRODUCTS.map((p) => [p.id, p.recommendedPrice])),
  )
  const [status, setStatus] = useState<Record<number, Status>>(
    Object.fromEntries(PRODUCTS.map((p) => [p.id, { state: 'idle' as const }])),
  )
  const [bulkBusy, setBulkBusy] = useState(false)

  function calcProfit(p: Product, price: number) {
    const fees = price * (0.13 + 0.029) + 0.30
    const ship = 3.0
    return Number((price - p.amazonCost - fees - ship).toFixed(2))
  }
  function calcRoi(p: Product, price: number) {
    const profit = calcProfit(p, price)
    return Number(((profit / p.amazonCost) * 100).toFixed(1))
  }

  async function listOne(p: Product) {
    const price = Number(prices[p.id])
    if (!Number.isFinite(price) || price <= 0) {
      setStatus((s) => ({ ...s, [p.id]: { state: 'error', message: 'Enter a valid price' } }))
      return
    }
    setStatus((s) => ({ ...s, [p.id]: { state: 'listing', message: 'Calling eBay…' } }))
    try {
      const res = await fetch('/api/ebay/list-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asin: p.asin,
          ebayPrice: price,
          amazonPrice: p.amazonCost,
          niche: 'Fishing & Hunting',
        }),
      })
      const data = await res.json()
      if (!res.ok || data?.ok === false) {
        const msg = data?.error?.message || data?.message || `Failed (${res.status})`
        setStatus((s) => ({ ...s, [p.id]: { state: 'error', message: msg.slice(0, 200) } }))
        return
      }
      const listingId = data?.listing?.itemId || data?.listingId || data?.itemId || ''
      setStatus((s) => ({
        ...s,
        [p.id]: { state: 'success', message: `Listed at $${price.toFixed(2)}`, listingId },
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatus((s) => ({ ...s, [p.id]: { state: 'error', message: msg } }))
    }
  }

  async function listAll() {
    setBulkBusy(true)
    for (const p of PRODUCTS) {
      if (status[p.id]?.state === 'success') continue
      await listOne(p)
      await new Promise((r) => setTimeout(r, 1500))
    }
    setBulkBusy(false)
  }

  return (
    <main style={{ padding: 24, maxWidth: 1100, margin: '0 auto', color: '#e5e7eb', background: '#0b1220', minHeight: '100vh' }}>
      <header style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Link href="/admin" style={{ color: '#7dd3fc', textDecoration: 'underline' }}>← Admin</Link>
          <h1 style={{ fontSize: 28, marginTop: 8, marginBottom: 4 }}>Quick List — 4 Fishing Products</h1>
          <p style={{ color: '#94a3b8', margin: 0 }}>One-off tool for buyer-specific listings. Edit price if you want, click List Now per row, or List All 4.</p>
        </div>
        <button
          onClick={listAll}
          disabled={bulkBusy}
          style={{
            padding: '12px 20px', borderRadius: 8, border: 'none',
            background: bulkBusy ? '#475569' : '#22c55e', color: 'white', fontWeight: 700,
            fontSize: 14, cursor: bulkBusy ? 'wait' : 'pointer',
          }}
        >
          {bulkBusy ? 'Listing all 4…' : '🚀 List All 4'}
        </button>
      </header>

      <div style={{ display: 'grid', gap: 16 }}>
        {PRODUCTS.map((p) => {
          const price = Number(prices[p.id])
          const profit = Number.isFinite(price) ? calcProfit(p, price) : 0
          const roi = Number.isFinite(price) ? calcRoi(p, price) : 0
          const s = status[p.id]
          return (
            <div
              key={p.id}
              style={{
                background: '#111827', borderRadius: 12, padding: 16,
                border: s.state === 'success' ? '2px solid #22c55e' : s.state === 'error' ? '2px solid #ef4444' : '1px solid #1f2937',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>ASIN <code style={{ color: '#7dd3fc' }}>{p.asin}</code></div>
                  <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>{p.title}</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr) auto', gap: 12, alignItems: 'end' }}>
                <Stat label="Amazon cost" value={`$${p.amazonCost.toFixed(2)}`} />
                <Stat label="eBay cheapest" value={`$${p.competitorMin.toFixed(2)}`} />
                <div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Your price</div>
                  <input
                    type="number"
                    step="0.01"
                    value={prices[p.id]}
                    onChange={(e) => setPrices((x) => ({ ...x, [p.id]: parseFloat(e.target.value) || 0 }))}
                    style={{
                      width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #334155',
                      background: '#0f172a', color: 'white', fontSize: 16, fontWeight: 600,
                    }}
                  />
                </div>
                <Stat label="Profit" value={`$${profit.toFixed(2)}`} color={profit > 0 ? '#22c55e' : '#ef4444'} />
                <Stat label="ROI" value={`${roi.toFixed(0)}%`} color={roi >= 25 ? '#22c55e' : roi >= 10 ? '#eab308' : '#ef4444'} />
                <button
                  onClick={() => listOne(p)}
                  disabled={s.state === 'listing' || s.state === 'success'}
                  style={{
                    padding: '10px 18px', borderRadius: 8, border: 'none',
                    background: s.state === 'success' ? '#16a34a' : s.state === 'listing' ? '#475569' : '#3b82f6',
                    color: 'white', fontWeight: 700, fontSize: 13, cursor: s.state === 'listing' ? 'wait' : 'pointer',
                  }}
                >
                  {s.state === 'success' ? '✓ Listed' : s.state === 'listing' ? 'Listing…' : 'List Now'}
                </button>
              </div>

              {s.message && (
                <div style={{
                  marginTop: 12, padding: '8px 12px', borderRadius: 6, fontSize: 13,
                  background: s.state === 'success' ? '#14532d' : s.state === 'error' ? '#7f1d1d' : '#1e293b',
                  color: s.state === 'success' ? '#bbf7d0' : s.state === 'error' ? '#fecaca' : '#cbd5e1',
                }}>
                  {s.message}
                  {s.listingId && (
                    <>
                      {' — '}
                      <a
                        href={`https://www.ebay.com/itm/${s.listingId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#86efac', textDecoration: 'underline' }}
                      >
                        view on eBay ↗
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: color || 'white' }}>{value}</div>
    </div>
  )
}
