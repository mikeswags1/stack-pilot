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
  const [oosState, setOosState] = useState<'idle' | 'previewing' | 'ready' | 'running' | 'done' | 'error'>('idle')
  const [oosCount, setOosCount] = useState<number>(0)
  const [oosSamples, setOosSamples] = useState<string[]>([])
  const [oosMessage, setOosMessage] = useState<string | null>(null)

  const handleEndOos = async () => {
    if (oosState === 'idle' || oosState === 'error' || oosState === 'done') {
      setOosState('previewing')
      setOosMessage(null)
      try {
        const res = await fetch('/api/ebay/end-oos')
        const data = await res.json()
        setOosCount(data.count || 0)
        setOosSamples(Array.isArray(data.samples) ? data.samples : [])
        setOosMessage(data.message || (res.ok ? 'Preview complete.' : 'Something went wrong.'))
        setOosState(res.ok ? 'ready' : 'error')
      } catch {
        setOosState('error')
        setOosMessage('Request failed. Check your eBay connection.')
      }
      return
    }

    if (oosState !== 'ready' || oosCount <= 0) return
    setOosState('running')
    setOosMessage(`Ending ${oosCount} out-of-stock listing${oosCount === 1 ? '' : 's'} on eBay...`)
    try {
      const res = await fetch('/api/ebay/end-oos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      const data = await res.json()
      setOosMessage(data.message || (res.ok ? 'Done.' : 'Something went wrong.'))
      if (res.ok && (data.remaining || 0) > 0) {
        setOosCount(data.remaining)
        setOosState('ready')
      } else {
        setOosState(res.ok ? 'done' : 'error')
      }
    } catch {
      setOosState('error')
      setOosMessage('Request failed. Check your eBay connection.')
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

          {/* End Out-of-Stock — protects account standing (prevents forced cancellations) */}
          <div className="card" style={{ padding: '28px', border: oosState === 'ready' && oosCount > 0 ? '1px solid rgba(248,81,73,0.45)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>End Out-of-Stock</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(248,81,73,0.10)', color: 'var(--red)', border: '1px solid rgba(248,81,73,0.28)' }}>
                Account Health
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Ends listings whose Amazon source is confirmed out of stock (flagged twice). These can&apos;t be fulfilled, so a sale forces a cancellation — an eBay defect. Click once to scan + preview, again to confirm.
            </div>
            {oosMessage ? (
              <div style={{ marginBottom: '12px', fontSize: '12px', color: oosState === 'error' ? 'var(--red)' : oosState === 'done' ? 'var(--grn)' : 'var(--gold)', padding: '8px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {oosMessage}
              </div>
            ) : null}
            {oosState === 'ready' && oosSamples.length > 0 ? (
              <div style={{ marginBottom: '12px', maxHeight: '130px', overflow: 'auto', fontSize: '11px', color: 'var(--dim)', lineHeight: 1.45 }}>
                <div style={{ color: 'var(--sil)', marginBottom: '6px', fontWeight: 600 }}>Examples it will end (verify these are right):</div>
                {oosSamples.map((title, idx) => (
                  <div key={idx} style={{ marginBottom: '5px' }}>• {title}</div>
                ))}
              </div>
            ) : null}
            <button
              className={`btn btn-sm ${oosState === 'ready' && oosCount > 0 ? 'btn-danger' : 'btn-ghost'}`}
              style={{ width: '100%', color: oosState !== 'ready' && oosState !== 'running' ? 'var(--red)' : undefined, borderColor: oosState !== 'ready' && oosState !== 'running' ? 'rgba(248,81,73,0.28)' : undefined }}
              disabled={oosState === 'previewing' || oosState === 'running' || (oosState === 'ready' && oosCount === 0)}
              onClick={handleEndOos}
            >
              {oosState === 'previewing'
                ? 'Scanning eBay...'
                : oosState === 'running'
                  ? 'Ending out-of-stock...'
                  : oosState === 'ready' && oosCount > 0
                    ? `⚠ Confirm — End ${oosCount} Out-of-Stock`
                    : oosState === 'ready'
                      ? 'None out of stock'
                      : oosState === 'done'
                        ? 'Done'
                        : 'Scan Out-of-Stock Listings'}
            </button>
            {oosState === 'ready' && oosCount > 0 ? (
              <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setOosState('idle'); setOosMessage(null); setOosSamples([]) }}>
                Cancel
              </button>
            ) : null}
          </div>

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
