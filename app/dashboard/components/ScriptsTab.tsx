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
    const endingCount = Math.min(deadPreview.count, 100)
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

          <div className="card" style={{ padding: '28px', border: deadState === 'ready' && (deadPreview?.count || 0) > 0 ? '1px solid rgba(34,197,94,0.32)' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px', gap: '12px' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--txt)' }}>Clean Dead Listings</div>
              <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '8px', fontWeight: 700, background: 'rgba(34,197,94,0.10)', color: 'var(--grn)', border: '1px solid rgba(34,197,94,0.28)' }}>
                Cleanup
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '22px', lineHeight: 1.6 }}>
              Preview listings that are 14+ days old with 0 sales, 0 watchers, and 2 or fewer views. Confirming ends only those poor performers.
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
                    ? `Confirm - End ${Math.min(deadPreview?.count || 0, 100)} Dead Listing${Math.min(deadPreview?.count || 0, 100) === 1 ? '' : 's'}`
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
