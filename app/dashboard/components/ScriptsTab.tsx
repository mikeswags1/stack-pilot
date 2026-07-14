import { useState } from 'react'
import type { ScriptMessage } from '../types'
import { SectionIntro } from './shared'

const SCRIPT_CARDS = [
  { title: 'Check Orders', file: 'check-orders.js', desc: 'Review all orders and surface any that need immediate action or follow-up.', badge: 'Operations' },
  { title: 'Listing Audit', file: 'listing-audit.js', desc: 'Scan live StackPilot listings for weak titles, one-image records, stale prices, unavailable Amazon sources, and margin risk.', badge: 'Quality' },
  { title: 'Product Finder', file: 'product-finder.js', desc: 'Open the sourcing workflow to find profitable products to list.', badge: 'Research' },
]

type DeadListingPreview = {
  count: number
  message?: string
  listings?: Array<{
    ebayListingId: string
    title: string
    views: number
    watchers: number
    quantitySold: number
    ageDays: number
    reason: string
  }>
}

type FeedbackPreview = {
  count: number
  message?: string
  candidates?: Array<{
    orderId: string
    lineItemId: string
    buyerUsername: string
    title: string
    reason: string
  }>
}

export function ScriptsTab({
  scriptRunning,
  scriptMessage,
  onRunScript,
  onOpenProductFinder,
}: {
  scriptRunning: string | null
  scriptMessage: ScriptMessage | null
  onRunScript: (file: string) => Promise<void>
  onOpenProductFinder: () => void
}) {
  const [endState, setEndState] = useState<'idle' | 'confirm' | 'running' | 'done' | 'error'>('idle')
  const [endResult, setEndResult] = useState<{ ended?: number; failed?: number; message?: string } | null>(null)
  const [deadState, setDeadState] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error'>('idle')
  const [deadPreview, setDeadPreview] = useState<DeadListingPreview | null>(null)
  const [deadMessage, setDeadMessage] = useState<string | null>(null)
  const [feedbackState, setFeedbackState] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error'>('idle')
  const [feedbackPreview, setFeedbackPreview] = useState<FeedbackPreview | null>(null)
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null)
  const [coinState, setCoinState] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error'>('idle')
  const [coinCount, setCoinCount] = useState<number>(0)
  const [coinMessage, setCoinMessage] = useState<string | null>(null)
  const [lossState, setLossState] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error'>('idle')
  const [lossCount, setLossCount] = useState<number>(0)
  const [lossSamples, setLossSamples] = useState<string[]>([])
  const [lossMessage, setLossMessage] = useState<string | null>(null)
  const [retitleState, setRetitleState] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error'>('idle')
  const [retitleCount, setRetitleCount] = useState<number>(0)
  const [retitleSamples, setRetitleSamples] = useState<Array<{ before: string; after: string }>>([])
  const [retitleMessage, setRetitleMessage] = useState<string | null>(null)
  const [symbolState, setSymbolState] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error'>('idle')
  const [symbolCount, setSymbolCount] = useState<number>(0)
  const [symbolSamples, setSymbolSamples] = useState<Array<{ account?: string; ebayListingId: string; before: string; after: string }>>([])
  const [symbolMessage, setSymbolMessage] = useState<string | null>(null)
  const [symbolVerifiedClean, setSymbolVerifiedClean] = useState(false)

  const handleEndLoss = async () => {
    if (lossState === 'idle' || lossState === 'error' || lossState === 'done') {
      setLossState('previewing')
      setLossMessage(null)
      try {
        const res = await fetch('/api/ebay/end-likely-loss')
        const data = await res.json()
        setLossCount(data.count || 0)
        setLossSamples(Array.isArray(data.samples) ? data.samples : [])
        setLossMessage(data.message || (res.ok ? 'Preview complete.' : 'Something went wrong.'))
        setLossState(res.ok ? 'ready' : 'error')
      } catch {
        setLossState('error')
        setLossMessage('Request failed. Check your eBay connection.')
      }
      return
    }

    if (lossState !== 'ready' || lossCount <= 0) return
    setLossState('running')
    setLossMessage(`Ending ${lossCount} likely-loss listing${lossCount === 1 ? '' : 's'} on eBay...`)
    try {
      const res = await fetch('/api/ebay/end-likely-loss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      const data = await res.json()
      setLossMessage(data.message || (res.ok ? 'Done.' : 'Something went wrong.'))
      if (res.ok && (data.remaining || 0) > 0) {
        setLossCount(data.remaining)
        setLossState('ready')
      } else {
        setLossState(res.ok ? 'done' : 'error')
      }
    } catch {
      setLossState('error')
      setLossMessage('Request failed. Check your eBay connection.')
    }
  }

  const handleRetitle = async () => {
    // First click previews how many titles would change; second click applies them.
    // Large stores return `remaining` and drop back to ready so you can click again.
    if (retitleState === 'idle' || retitleState === 'error' || retitleState === 'done') {
      setRetitleState('previewing')
      setRetitleMessage(null)
      try {
        const res = await fetch('/api/ebay/retitle-brands')
        const data = await res.json()
        setRetitleCount(data.count || 0)
        setRetitleSamples(Array.isArray(data.samples) ? data.samples : [])
        setRetitleMessage(data.message || (res.ok ? 'Preview complete.' : 'Something went wrong.'))
        setRetitleState(res.ok ? 'ready' : 'error')
      } catch {
        setRetitleState('error')
        setRetitleMessage('Request failed. Check your eBay connection.')
      }
      return
    }

    if (retitleState !== 'ready' || retitleCount <= 0) return
    setRetitleState('running')
    setRetitleMessage(`Cleaning ${retitleCount} title${retitleCount === 1 ? '' : 's'} on eBay...`)
    try {
      const res = await fetch('/api/ebay/retitle-brands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      const data = await res.json()
      setRetitleMessage(data.message || (res.ok ? 'Done.' : 'Something went wrong.'))
      if (res.ok && (data.remaining || 0) > 0) {
        setRetitleCount(data.remaining)
        setRetitleState('ready')
      } else {
        setRetitleState(res.ok ? 'done' : 'error')
      }
    } catch {
      setRetitleState('error')
      setRetitleMessage('Request failed. Check your eBay connection.')
    }
  }

  const handleBrokenTitleSymbols = async () => {
    // First click reads every live title directly from each connected eBay account.
    // Confirmation performs another complete live scan before changing Title only.
    if (symbolState === 'idle' || symbolState === 'error' || symbolState === 'done') {
      setSymbolState('previewing')
      setSymbolMessage(null)
      setSymbolSamples([])
      setSymbolVerifiedClean(false)
      try {
        const res = await fetch('/api/ebay/repair-title-entities', { cache: 'no-store' })
        const data = await res.json()
        const count = Number(data.count || 0)
        setSymbolCount(count)
        setSymbolSamples(Array.isArray(data.samples) ? data.samples : [])
        setSymbolMessage(data.message || data.error?.message || (res.ok ? 'Preview complete.' : 'Something went wrong.'))
        if (!res.ok) {
          setSymbolState('error')
        } else if (count === 0) {
          setSymbolVerifiedClean(true)
          setSymbolState('done')
        } else {
          setSymbolState('ready')
        }
      } catch {
        setSymbolState('error')
        setSymbolMessage('Request failed. Check your eBay connection.')
      }
      return
    }

    if (symbolState !== 'ready' || symbolCount <= 0) return
    setSymbolState('running')
    setSymbolMessage(`Repairing up to ${Math.min(symbolCount, 50)} live title${symbolCount === 1 ? '' : 's'} on eBay...`)
    try {
      const res = await fetch('/api/ebay/repair-title-entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      const data = await res.json()
      const remaining = Number(data.remaining || 0)
      setSymbolCount(remaining)
      setSymbolSamples([])
      setSymbolMessage(data.message || data.error?.message || (res.ok ? 'Repair complete.' : 'Something went wrong.'))
      setSymbolVerifiedClean(Boolean(data.verifiedClean))
      if (!res.ok) {
        setSymbolState('error')
      } else if (remaining > 0) {
        setSymbolState('ready')
      } else {
        // If final verification could not finish, this returns to a fresh full scan
        // on the next click instead of claiming the store is clean.
        setSymbolState('done')
      }
    } catch {
      setSymbolState('error')
      setSymbolMessage('Request failed. Check your eBay connection.')
    }
  }

  const handleEndCoins = async () => {
    // First click previews the count; second click ends them. If a run can't finish all
    // (large stores), the API returns `remaining` and we drop back to ready to click again.
    if (coinState === 'idle' || coinState === 'error' || coinState === 'done') {
      setCoinState('previewing')
      setCoinMessage(null)
      try {
        const res = await fetch('/api/ebay/end-coins')
        const data = await res.json()
        setCoinCount(data.count || 0)
        setCoinMessage(data.message || (res.ok ? 'Preview complete.' : 'Something went wrong.'))
        setCoinState(res.ok ? 'ready' : 'error')
      } catch {
        setCoinState('error')
        setCoinMessage('Request failed. Check your eBay connection.')
      }
      return
    }

    if (coinState !== 'ready' || coinCount <= 0) return
    setCoinState('running')
    setCoinMessage(`Ending ${coinCount} coin listing${coinCount === 1 ? '' : 's'} on eBay...`)
    try {
      const res = await fetch('/api/ebay/end-coins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      const data = await res.json()
      setCoinMessage(data.message || (res.ok ? 'Done.' : 'Something went wrong.'))
      if (res.ok && (data.remaining || 0) > 0) {
        setCoinCount(data.remaining)
        setCoinState('ready')
      } else {
        setCoinState(res.ok ? 'done' : 'error')
      }
    } catch {
      setCoinState('error')
      setCoinMessage('Request failed. Check your eBay connection.')
    }
  }

  const handleEndAllListings = async () => {
    if (endState === 'idle') { setEndState('confirm'); return }
    if (endState !== 'confirm') return
    setEndState('running')
    try {
      const res = await fetch('/api/ebay/end-listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      const data = await res.json()
      setEndResult({ message: data.message || (res.ok ? 'Done.' : 'Something went wrong.') })
      setEndState(res.ok ? 'done' : 'error')
    } catch {
      setEndState('error')
      setEndResult({ message: 'Request failed. Check your eBay connection.' })
    }
  }

  const handleDeadListingCleanup = async () => {
    if (deadState === 'idle' || deadState === 'error' || deadState === 'done') {
      setDeadState('previewing')
      setDeadMessage(null)
      setDeadPreview(null)
      try {
        const res = await fetch('/api/ebay/dead-listings')
        const data = await res.json()
        setDeadPreview(data)
        setDeadMessage(data.message || (res.ok ? 'Preview complete.' : 'Something went wrong.'))
        setDeadState(res.ok ? 'ready' : 'error')
      } catch {
        setDeadState('error')
        setDeadMessage('Request failed. Check your eBay connection.')
      }
      return
    }

    if (deadState !== 'ready' || !deadPreview?.count) return
    setDeadState('running')
    const endingCount = deadPreview.count
    setDeadMessage(`Ending ${endingCount} dead listing${endingCount === 1 ? '' : 's'} on eBay...`)
    try {
      const res = await fetch('/api/ebay/dead-listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      const data = await res.json()
      setDeadMessage(data.message || (res.ok ? 'Cleanup complete.' : 'Something went wrong.'))
      setDeadState(res.ok ? 'done' : 'error')
    } catch {
      setDeadState('error')
      setDeadMessage('Request failed. Check your eBay connection.')
    }
  }

  const handleFeedbackRequests = async () => {
    if (feedbackState === 'idle' || feedbackState === 'error' || feedbackState === 'done') {
      setFeedbackState('previewing')
      setFeedbackMessage(null)
      setFeedbackPreview(null)
      try {
        const res = await fetch('/api/ebay/feedback-requests')
        const data = await res.json()
        setFeedbackPreview(data)
        setFeedbackMessage(data.message || (res.ok ? 'Preview complete.' : 'Something went wrong.'))
        setFeedbackState(res.ok ? 'ready' : 'error')
      } catch {
        setFeedbackState('error')
        setFeedbackMessage('Request failed. Check your eBay connection.')
      }
      return
    }

    if (feedbackState !== 'ready' || !feedbackPreview?.count) return
    setFeedbackState('running')
    setFeedbackMessage(`Sending ${Math.min(feedbackPreview.count, 10)} feedback request${Math.min(feedbackPreview.count, 10) === 1 ? '' : 's'}...`)
    try {
      const res = await fetch('/api/ebay/feedback-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      setFeedbackMessage(data.message || (res.ok ? 'Feedback requests sent.' : 'Something went wrong.'))
      setFeedbackState(res.ok ? 'done' : 'error')
    } catch {
      setFeedbackState('error')
      setFeedbackMessage('Request failed. Check your eBay connection.')
    }
  }

  return (
    <div style={{ animation: 'fadein 0.22s ease' }}>
      <SectionIntro eyebrow="StackPilot / Automation" title="Scripts" />
      <div style={{ padding: `0 var(--xpad) 44px` }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: '18px' }}>

          {/* End All Listings — special destructive action */}
          <div className="card" style={{ padding: '28px', border: endState === 'confirm' ? '1px solid rgba(248,81,73,0.45)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>End All Listings</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(248,81,73,0.10)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.28)' }}>
                Danger
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Immediately ends every active listing on your eBay account. Cannot be undone. Inactive/unsold listings must be deleted manually in eBay Seller Hub (Inactive → Select all → Delete).
            </div>
            {endResult ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: endState === 'done' ? 'var(--grn)' : 'var(--red)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {endResult.message}
              </div>
            ) : endState === 'confirm' ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: 'var(--red)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.25)' }}>
                ⚠ This will end every active listing. Click again to confirm.
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${endState === 'confirm' ? 'btn-danger' : 'btn-ghost'}`}
              style={{ width: '100%', color: endState !== 'confirm' ? 'var(--red)' : undefined, borderColor: endState !== 'confirm' ? 'rgba(248,81,73,0.28)' : undefined }}
              disabled={endState === 'running' || endState === 'done'}
              onClick={handleEndAllListings}
            >
              {endState === 'running' ? 'Ending listings...' : endState === 'done' ? 'Done' : endState === 'confirm' ? '⚠ Confirm — End All Listings' : 'End All Listings'}
            </button>
            {endState === 'confirm' ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => setEndState('idle')}>
                Cancel
              </button>
            ) : null}
          </div>

          {/* End All Coins — targeted precious-metal loss cleanup */}
          <div className="card" style={{ padding: '28px', border: coinState === 'ready' && coinCount > 0 ? '1px solid rgba(248,81,73,0.45)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>End All Coins</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(248,81,73,0.10)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.28)' }}>
                Loss Cleanup
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Ends ONLY your coin &amp; bullion listings (Silver/Gold Eagle, .999, bullion, etc.). Their Amazon prices are unreliable and can sell below cost. Your normal products are never touched. Click once to scan, again to confirm.
            </div>
            {coinMessage ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: coinState === 'error' ? 'var(--red)' : coinState === 'done' ? 'var(--grn)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {coinMessage}
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${coinState === 'ready' && coinCount > 0 ? 'btn-danger' : 'btn-ghost'}`}
              style={{ width: '100%', color: coinState !== 'ready' && coinState !== 'running' ? 'var(--red)' : undefined, borderColor: coinState !== 'ready' && coinState !== 'running' ? 'rgba(248,81,73,0.28)' : undefined }}
              disabled={coinState === 'previewing' || coinState === 'running' || (coinState === 'ready' && coinCount === 0)}
              onClick={handleEndCoins}
            >
              {coinState === 'previewing'
                ? 'Scanning eBay...'
                : coinState === 'running'
                  ? 'Ending coins...'
                  : coinState === 'ready' && coinCount > 0
                    ? `⚠ Confirm — End ${coinCount} Coin Listing${coinCount === 1 ? '' : 's'}`
                    : coinState === 'ready'
                      ? 'No coins found'
                      : coinState === 'done'
                        ? 'Done'
                        : 'Scan & End Coin Listings'}
            </button>
            {coinState === 'ready' && coinCount > 0 ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setCoinState('idle'); setCoinMessage(null) }}>
                Cancel
              </button>
            ) : null}
          </div>

          {/* End Likely-Loss — listings selling below Amazon cost (profit guard) */}
          <div className="card" style={{ padding: '28px', border: lossState === 'ready' && lossCount > 0 ? '1px solid rgba(248,81,73,0.45)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>End Likely-Loss</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(248,81,73,0.10)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.28)' }}>
                Profit Guard
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Ends listings where Amazon now costs more than your eBay price (a real loss if they sell). Skips obvious bad-data false alarms. Click once to scan + preview the prices, again to confirm.
            </div>
            {lossMessage ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: lossState === 'error' ? 'var(--red)' : lossState === 'done' ? 'var(--grn)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {lossMessage}
              </div>
            ) : null}
            {lossState === 'ready' && lossSamples.length > 0 ? (
              <div style={{ marginBottom: '12px', maxHeight: '150px', overflow: 'auto', fontSize: '11px', color: 'var(--dim)', lineHeight: 1.5 }}>
                <div style={{ color: 'var(--sil)', marginBottom: '6px', fontWeight: 600 }}>Examples it will end (verify the prices):</div>
                {lossSamples.map((s, idx) => (
                  <div key={idx} style={{ marginBottom: '5px' }}>• {s}</div>
                ))}
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${lossState === 'ready' && lossCount > 0 ? 'btn-danger' : 'btn-ghost'}`}
              style={{ width: '100%', color: lossState !== 'ready' && lossState !== 'running' ? 'var(--red)' : undefined, borderColor: lossState !== 'ready' && lossState !== 'running' ? 'rgba(248,81,73,0.28)' : undefined }}
              disabled={lossState === 'previewing' || lossState === 'running' || (lossState === 'ready' && lossCount === 0)}
              onClick={handleEndLoss}
            >
              {lossState === 'previewing'
                ? 'Scanning prices...'
                : lossState === 'running'
                  ? 'Ending loss-makers...'
                  : lossState === 'ready' && lossCount > 0
                    ? `⚠ Confirm — End ${lossCount} Loss-Makers`
                    : lossState === 'ready'
                      ? 'No loss-makers found'
                      : lossState === 'done'
                        ? 'Done'
                        : 'Scan for Loss-Making Listings'}
            </button>
            {lossState === 'ready' && lossCount > 0 ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setLossState('idle'); setLossMessage(null); setLossSamples([]) }}>
                Cancel
              </button>
            ) : null}
          </div>

          {/* Repair literal HTML/entity codes accidentally shown to eBay buyers. */}
          <div className="card" style={{ padding: '28px', border: symbolState === 'ready' && symbolCount > 0 ? '1px solid rgba(63,185,80,0.45)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>Fix Broken Title Symbols</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(63,185,80,0.10)', color: 'var(--grn)', border: '1px solid rgba(63,185,80,0.28)' }}>
                Title Repair
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Finds titles showing broken codes like #x27 instead of an apostrophe, then fixes only those symbols. It scans every connected eBay account live and never changes the product, price, images, brand, or keywords. Click once to preview, again to repair.
            </div>
            {symbolMessage ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: symbolState === 'error' ? 'var(--red)' : symbolState === 'done' && symbolVerifiedClean ? 'var(--grn)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {symbolMessage}
              </div>
            ) : null}
            {symbolState === 'ready' && symbolSamples.length > 0 ? (
              <div style={{ marginBottom: '12px', maxHeight: '180px', overflow: 'auto', fontSize: '11px', color: 'var(--dim)', lineHeight: 1.5 }}>
                <div style={{ color: 'var(--sil)', marginBottom: '6px', fontWeight: 600 }}>Live eBay preview (before → after):</div>
                {symbolSamples.map((sample) => (
                  <div key={`${sample.ebayListingId}:${sample.after}`} style={{ marginBottom: '7px' }}>
                    {sample.account ? <div style={{ color: 'var(--dim)', fontSize: '9px' }}>{sample.account}</div> : null}
                    <div style={{ color: 'var(--red)', textDecoration: 'line-through', opacity: 0.7 }}>{sample.before}</div>
                    <div style={{ color: 'var(--grn)' }}>{sample.after}</div>
                  </div>
                ))}
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${symbolState === 'ready' && symbolCount > 0 ? 'btn-primary' : 'btn-ghost'}`}
              disabled={symbolState === 'previewing' || symbolState === 'running'}
              onClick={handleBrokenTitleSymbols}
              style={{ width: '100%' }}
            >
              {symbolState === 'previewing'
                ? 'Scanning every live title...'
                : symbolState === 'running'
                  ? 'Fixing broken symbols...'
                  : symbolState === 'ready' && symbolCount > 0
                    ? `Confirm — Fix ${symbolCount} Title${symbolCount === 1 ? '' : 's'}`
                    : symbolState === 'done' && symbolVerifiedClean
                      ? 'Verified Clean — Scan Again'
                      : symbolState === 'done'
                        ? 'Scan Again to Verify'
                        : symbolState === 'error'
                          ? 'Try Full Scan Again'
                          : 'Preview Broken Title Symbols'}
            </button>
            {symbolState === 'ready' && symbolCount > 0 ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setSymbolState('idle'); setSymbolCount(0); setSymbolSamples([]); setSymbolMessage(null); setSymbolVerifiedClean(false) }}>
                Cancel
              </button>
            ) : null}
          </div>

          {/* Clean Brand Titles — strip obscure Amazon brand prefixes for SEO (non-destructive) */}
          <div className="card" style={{ padding: '28px', border: retitleState === 'ready' && retitleCount > 0 ? '1px solid rgba(63,185,80,0.45)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>Clean Brand Titles</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(63,185,80,0.10)', color: 'var(--grn)', border: '1px solid rgba(63,185,80,0.28)' }}>
                SEO
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Rewrites live listings that lead with an obscure Amazon brand (SONGMICS, DkOvn…) so the title starts with product keywords buyers actually search. The brand stays in the Brand filter — nothing is deleted. Click once to preview, again to apply.
            </div>
            {retitleMessage ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: retitleState === 'error' ? 'var(--red)' : retitleState === 'done' ? 'var(--grn)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {retitleMessage}
              </div>
            ) : null}
            {retitleState === 'ready' && retitleSamples.length > 0 ? (
              <div style={{ marginBottom: '12px', maxHeight: '180px', overflow: 'auto', fontSize: '11px', color: 'var(--dim)', lineHeight: 1.5 }}>
                <div style={{ color: 'var(--sil)', marginBottom: '6px', fontWeight: 600 }}>Preview (before → after):</div>
                {retitleSamples.map((s, idx) => (
                  <div key={idx} style={{ marginBottom: '7px' }}>
                    <div style={{ color: 'var(--red)', textDecoration: 'line-through', opacity: 0.7 }}>{s.before}</div>
                    <div style={{ color: 'var(--grn)' }}>{s.after}</div>
                  </div>
                ))}
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${retitleState === 'ready' && retitleCount > 0 ? 'btn-primary' : 'btn-ghost'}`}
              disabled={retitleState === 'previewing' || retitleState === 'running' || (retitleState === 'ready' && retitleCount === 0)}
              onClick={handleRetitle}
              style={{ width: '100%' }}
            >
              {retitleState === 'previewing'
                ? 'Scanning titles...'
                : retitleState === 'running'
                  ? 'Cleaning titles...'
                  : retitleState === 'ready' && retitleCount > 0
                    ? `Clean ${retitleCount} Title${retitleCount === 1 ? '' : 's'}`
                    : retitleState === 'ready'
                      ? 'No brand-heavy titles found'
                      : retitleState === 'done'
                        ? 'Done'
                        : 'Scan Titles for Obscure Brands'}
            </button>
            {retitleState === 'ready' && retitleCount > 0 ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setRetitleState('idle'); setRetitleMessage(null); setRetitleSamples([]) }}>
                Cancel
              </button>
            ) : null}
          </div>

          {/* End Out-of-Stock card removed 2026-06-30: the Amazon availability data was found
              unreliable (false out-of-stock on in-stock items), so the button was confusing and
              its action is disabled server-side. Re-add once the availability source is trustworthy. */}

          <div className="card" style={{ padding: '28px', border: deadState === 'ready' && (deadPreview?.count || 0) > 0 ? '1px solid rgba(34,197,94,0.32)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>Clean Dead Listings</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(34,197,94,0.10)', color: 'var(--grn)', border: '1px solid rgba(34,197,94,0.28)' }}>
                Cleanup
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Preview live eBay listings that are 14+ days old with 0 sales, 0 watchers, and 10 or fewer views. Confirming ends only those poor performers.
            </div>
            {deadMessage ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: deadState === 'error' ? 'var(--red)' : deadState === 'done' ? 'var(--grn)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {deadMessage}
              </div>
            ) : null}
            {deadState === 'ready' && deadPreview?.listings?.length ? (
              <div style={{ marginBottom: '12px', maxHeight: '130px', overflow: 'auto', fontSize: '11px', color: 'var(--dim)', lineHeight: 1.45 }}>
                {deadPreview.listings.slice(0, 5).map((listing) => (
                  <div key={listing.ebayListingId} style={{ marginBottom: '6px' }}>
                    <strong style={{ color: 'var(--sil)' }}>{listing.views} views</strong> - {listing.title}
                  </div>
                ))}
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${deadState === 'ready' && (deadPreview?.count || 0) > 0 ? 'btn-gold' : 'btn-ghost'}`}
              style={{ width: '100%' }}
              disabled={deadState === 'previewing' || deadState === 'running' || (deadState === 'ready' && !deadPreview?.count)}
              onClick={handleDeadListingCleanup}
            >
              {deadState === 'previewing'
                ? 'Checking eBay...'
                : deadState === 'running'
                  ? 'Ending dead listings...'
                  : deadState === 'ready' && (deadPreview?.count || 0) > 0
                    ? `Confirm - End ${deadPreview?.count || 0} Dead Listing${deadPreview?.count === 1 ? '' : 's'}`
                    : deadState === 'done'
                      ? 'Run Another Preview'
                      : 'Preview Dead Listings'}
            </button>
            {deadState === 'ready' ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setDeadState('idle'); setDeadPreview(null); setDeadMessage(null) }}>
                Cancel
              </button>
            ) : null}
          </div>

          <div className="card" style={{ padding: '28px', border: feedbackState === 'ready' && (feedbackPreview?.count || 0) > 0 ? '1px solid rgba(34,197,94,0.32)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>Request Feedback</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(34,197,94,0.10)', color: 'var(--grn)', border: '1px solid rgba(34,197,94,0.28)' }}>
                Follow-up
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Preview fulfilled orders that are delivered or likely delivered, skip buyers who already left feedback, then send a polite feedback request. Sent buyers are logged so they are not messaged again.
            </div>
            {feedbackMessage ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: feedbackState === 'error' ? 'var(--red)' : feedbackState === 'done' ? 'var(--grn)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {feedbackMessage}
              </div>
            ) : null}
            {feedbackState === 'ready' && feedbackPreview?.candidates?.length ? (
              <div style={{ marginBottom: '12px', maxHeight: '130px', overflow: 'auto', fontSize: '11px', color: 'var(--dim)', lineHeight: 1.45 }}>
                {feedbackPreview.candidates.slice(0, 5).map((candidate) => (
                  <div key={candidate.lineItemId} style={{ marginBottom: '6px' }}>
                    <strong style={{ color: 'var(--sil)' }}>{candidate.buyerUsername}</strong> - {candidate.title}
                  </div>
                ))}
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${feedbackState === 'ready' && (feedbackPreview?.count || 0) > 0 ? 'btn-gold' : 'btn-ghost'}`}
              style={{ width: '100%' }}
              disabled={feedbackState === 'previewing' || feedbackState === 'running' || (feedbackState === 'ready' && !feedbackPreview?.count)}
              onClick={handleFeedbackRequests}
            >
              {feedbackState === 'previewing'
                ? 'Checking feedback...'
                : feedbackState === 'running'
                  ? 'Sending requests...'
                  : feedbackState === 'ready' && (feedbackPreview?.count || 0) > 0
                    ? `Confirm - Message ${Math.min(feedbackPreview?.count || 0, 10)} Buyer${Math.min(feedbackPreview?.count || 0, 10) === 1 ? '' : 's'}`
                    : feedbackState === 'done'
                      ? 'Run Another Preview'
                      : 'Preview Feedback Requests'}
            </button>
            {feedbackState === 'ready' ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setFeedbackState('idle'); setFeedbackPreview(null); setFeedbackMessage(null) }}>
                Cancel
              </button>
            ) : null}
          </div>

          {SCRIPT_CARDS.map((script) => {
            const isRunning = scriptRunning === script.file
            const isProductFinder = script.file === 'product-finder.js'
            const message = scriptMessage?.file === script.file ? scriptMessage : null

            return (
              <div key={script.file} className="card" style={{ padding: '28px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>{script.title}</div>
                  <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, letterSpacing: 0, background: 'rgba(14,165,233,0.08)', color: 'var(--plat)', border: '1px solid rgba(14,165,233,0.22)' }}>
                    {script.badge}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--dim)', marginBottom: '8px', fontFamily: 'monospace', opacity: 0.7 }}>{script.file}</div>
                <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>{script.desc}</div>
                {message ? (
                  <div style={{ marginBottom: '12px', fontSize: '12px', color: message.tone === 'success' ? 'var(--grn)' : message.tone === 'error' ? 'var(--red)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(14,116,144,0.12)' }}>
                    {message.text}
                  </div>
                ) : null}
                <button
                  className="btn btn-gold btn-sm"
                  style={{ width: '100%' }}
                  disabled={isRunning}
                  onClick={() => (isProductFinder ? onOpenProductFinder() : onRunScript(script.file))}
                >
                  {isRunning ? 'Running...' : isProductFinder ? 'Open Product Finder' : 'Run Script'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
