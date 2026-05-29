'use client'

import { useCallback, useEffect, useState } from 'react'
import { SectionIntro } from './shared'

type CampaignStatus = 'RUNNING' | 'PAUSED' | 'ENDED' | 'SCHEDULED' | string

interface Campaign {
  campaignId: string
  campaignName: string
  campaignStatus: CampaignStatus
  campaignType: string
  listingCount?: number | null
  activeListingCount?: number
  fundingStrategy?: {
    bidPercentage?: string
    fundingModel?: string
  }
  startDate?: string
  endDate?: string
}

type BoostState = 'idle' | 'running' | 'done' | 'error'

function statusBadge(status: CampaignStatus) {
  const map: Record<string, { label: string; bg: string; color: string }> = {
    RUNNING:   { label: 'Active',    bg: 'rgba(34,197,94,0.10)',   color: 'var(--grn)' },
    PAUSED:    { label: 'Paused',    bg: 'rgba(250,204,21,0.10)',  color: 'var(--gold)' },
    ENDED:     { label: 'Ended',     bg: 'rgba(255,255,255,0.05)', color: 'var(--dim)' },
    SCHEDULED: { label: 'Scheduled', bg: 'rgba(14,165,233,0.10)',  color: 'var(--plat)' },
  }
  const s = map[status] || { label: status, bg: 'rgba(255,255,255,0.05)', color: 'var(--dim)' }
  return (
    <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '10px', fontWeight: 700,
      background: s.bg, color: s.color, border: `1px solid ${s.color}44` }}>
      {s.label}
    </span>
  )
}

export function CampaignsTab({ connected }: { connected: boolean }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [activeListingCount, setActiveListingCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRate, setNewRate] = useState('3')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Per-campaign boost state
  const [boostState, setBoostState] = useState<Record<string, BoostState>>({})
  const [boostMessage, setBoostMessage] = useState<Record<string, string>>({})

  // Per-campaign pause/resume state
  const [toggleState, setToggleState] = useState<Record<string, 'idle' | 'loading'>>({})

  const loadCampaigns = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/ebay/campaigns')
      const data = await res.json()
      if (!res.ok || data?.ok === false) {
        setError(data?.error?.message || 'Failed to load campaigns.')
        return
      }
      setCampaigns(data.campaigns || [])
      setActiveListingCount(Number(data.activeListingCount || 0))
    } catch {
      setError('Failed to load campaigns. Check your connection.')
    } finally {
      setLoading(false)
    }
  }, [])

  const needsReconnect = error?.toLowerCase().includes('access denied') ||
    error?.toLowerCase().includes('access_denied') ||
    createError?.toLowerCase().includes('access denied')

  useEffect(() => {
    if (connected) void loadCampaigns()
  }, [connected, loadCampaigns])

  const handleCreate = async () => {
    if (!newName.trim()) { setCreateError('Enter a campaign name.'); return }
    const rate = parseFloat(newRate)
    if (!Number.isFinite(rate) || rate < 1 || rate > 20) { setCreateError('Rate must be 1–20%.'); return }

    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/ebay/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), adRate: rate }),
      })
      const data = await res.json()
      if (!res.ok || data?.ok === false) {
        setCreateError(data?.error?.message || 'Failed to create campaign.')
        return
      }
      setNewName('')
      setNewRate('3')
      setShowCreate(false)
      await loadCampaigns()
    } catch {
      setCreateError('Request failed. Try again.')
    } finally {
      setCreating(false)
    }
  }

  const handleBoost = async (campaign: Campaign) => {
    const id = campaign.campaignId
    setBoostState(prev => ({ ...prev, [id]: 'running' }))
    setBoostMessage(prev => ({ ...prev, [id]: '' }))

    try {
      const res = await fetch(`/api/ebay/campaigns/${id}/listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adRate: campaign.fundingStrategy?.bidPercentage }),
      })
      const data = await res.json()
      const msg = data?.message || (res.ok ? 'Done.' : 'Failed.')
      setBoostMessage(prev => ({ ...prev, [id]: msg }))
      setBoostState(prev => ({ ...prev, [id]: res.ok ? 'done' : 'error' }))
      if (res.ok) {
        const added = Number(data?.added || 0)
        const total = Number(data?.total || 0)
        setCampaigns(prev => prev.map(c =>
          c.campaignId === id
            ? { ...c, listingCount: Math.max(Number(c.listingCount || 0), added || total || Number(c.listingCount || 0)) }
            : c
        ))
      }
    } catch {
      setBoostMessage(prev => ({ ...prev, [id]: 'Request failed.' }))
      setBoostState(prev => ({ ...prev, [id]: 'error' }))
    }
  }

  const handleToggle = async (campaign: Campaign) => {
    const id = campaign.campaignId
    const action = campaign.campaignStatus === 'RUNNING' ? 'pause' : 'resume'
    setToggleState(prev => ({ ...prev, [id]: 'loading' }))

    try {
      const res = await fetch(`/api/ebay/campaigns/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        setCampaigns(prev => prev.map(c =>
          c.campaignId === id
            ? { ...c, campaignStatus: action === 'pause' ? 'PAUSED' : 'RUNNING' }
            : c
        ))
      }
    } catch { /* ignore */ } finally {
      setToggleState(prev => ({ ...prev, [id]: 'idle' }))
    }
  }

  if (!connected) {
    return (
      <div style={{ animation: 'fadein 0.22s ease' }}>
        <SectionIntro eyebrow="StackPilot / Marketing" title="Campaigns" />
        <div style={{ padding: '0 var(--xpad) 44px' }}>
          <div className="card" style={{ padding: '32px', textAlign: 'center', color: 'var(--sil)', fontSize: '14px' }}>
            Connect your eBay account in Settings to manage Promoted Listings campaigns.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ animation: 'fadein 0.22s ease' }}>
      <SectionIntro
        eyebrow="StackPilot / Marketing"
        title="Campaigns"
        subtitle="Promoted Listings — pay a % of each sale to boost visibility in eBay search."
      />

      <div style={{ padding: '0 var(--xpad) 44px' }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowCreate(v => !v); setCreateError(null) }}>
            {showCreate ? 'Cancel' : '+ New Campaign'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void loadCampaigns()} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="card" style={{ padding: '24px', marginBottom: '24px', border: '1px solid rgba(14,165,233,0.25)' }}>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '18px', fontWeight: 600, color: 'var(--txt)', marginBottom: '18px' }}>
              New Promoted Listings Campaign
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px', alignItems: 'end' }}>
              <div>
                <label style={{ fontSize: '11px', color: 'var(--dim)', display: 'block', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Campaign Name
                </label>
                <input
                  className="input"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. Gaming Gear May 2026"
                  style={{ width: '100%' }}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                />
              </div>
              <div style={{ minWidth: '120px' }}>
                <label style={{ fontSize: '11px', color: 'var(--dim)', display: 'block', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Ad Rate %
                </label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="20"
                  step="0.5"
                  value={newRate}
                  onChange={e => setNewRate(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--dim)', marginTop: '8px', marginBottom: '16px' }}>
              You pay {newRate}% of the final sale price only when a buyer finds your listing through a Promoted Listings ad and purchases within 30 days.
            </div>
            {createError && (
              <div style={{ fontSize: '12px', color: 'var(--red)', marginBottom: '12px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(248,81,73,0.08)' }}>
                {createError}
              </div>
            )}
            <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={creating}>
              {creating ? 'Creating…' : 'Create Campaign'}
            </button>
          </div>
        )}

        {/* Error — special case for missing Marketing scope */}
        {error && (
          <div style={{ fontSize: '13px', color: needsReconnect ? 'var(--gold)' : 'var(--red)', padding: '14px 16px', borderRadius: '10px', background: needsReconnect ? 'rgba(250,204,21,0.08)' : 'rgba(248,81,73,0.08)', marginBottom: '20px', border: `1px solid ${needsReconnect ? 'rgba(250,204,21,0.3)' : 'rgba(248,81,73,0.25)'}` }}>
            {needsReconnect ? (
              <>
                <strong>eBay Marketing access not enabled.</strong> Your current eBay connection was made before Campaigns were added and is missing the Marketing API permission.
                <br /><br />
                Go to <strong>Settings → Disconnect eBay → Reconnect eBay</strong> to grant the new permission. This takes about 30 seconds and does not affect your listings.
              </>
            ) : error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && campaigns.length === 0 && (
          <div className="card" style={{ padding: '40px', textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>📢</div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', color: 'var(--txt)', marginBottom: '8px' }}>No campaigns yet</div>
            <div style={{ fontSize: '13px', color: 'var(--sil)', marginBottom: '20px', maxWidth: '380px', margin: '0 auto 20px' }}>
              Create your first Promoted Listings campaign to boost visibility in eBay search results. You only pay when an ad leads to a sale.
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
              + Create First Campaign
            </button>
          </div>
        )}

        {/* Campaign cards */}
        {campaigns.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '18px' }}>
            {campaigns.map(campaign => {
              const id = campaign.campaignId
              const rate = campaign.fundingStrategy?.bidPercentage
              const isRunning = campaign.campaignStatus === 'RUNNING'
              const isEnded = campaign.campaignStatus === 'ENDED'
              const bState = boostState[id] || 'idle'
              const bMsg = boostMessage[id]
              const toggling = toggleState[id] === 'loading'
              const campaignListingCount = typeof campaign.listingCount === 'number' ? campaign.listingCount : null
              const storeListingCount = campaign.activeListingCount ?? activeListingCount

              return (
                <div key={id} className="card" style={{ padding: '24px' }}>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '16px' }}>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: '17px', fontWeight: 600, color: 'var(--txt)', lineHeight: 1.3, flex: 1 }}>
                      {campaign.campaignName}
                    </div>
                    {statusBadge(campaign.campaignStatus)}
                  </div>

                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: '20px', marginBottom: '20px' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Ad Rate</div>
                      <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--gold)' }}>
                        {rate ? `${parseFloat(rate).toFixed(1)}%` : '—'}
                      </div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Listings</div>
                      <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--txt)' }}>
                        {campaignListingCount === null ? '...' : campaignListingCount}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--dim)', marginTop: '2px' }}>
                        of {storeListingCount} active
                      </div>
                    </div>
                    {campaign.startDate && (
                      <div>
                        <div style={{ fontSize: '11px', color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Started</div>
                        <div style={{ fontSize: '13px', color: 'var(--sil)' }}>{campaign.startDate.split('T')[0]}</div>
                      </div>
                    )}
                  </div>

                  {/* Boost result message */}
                  {bMsg && (
                    <div style={{
                      fontSize: '12px',
                      color: bState === 'error' ? 'var(--red)' : 'var(--grn)',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      background: bState === 'error' ? 'rgba(248,81,73,0.08)' : 'rgba(34,197,94,0.08)',
                      marginBottom: '12px',
                    }}>
                      {bMsg}
                    </div>
                  )}

                  {/* Actions */}
                  {!isEnded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ width: '100%' }}
                        disabled={bState === 'running' || !isRunning}
                        onClick={() => handleBoost(campaign)}
                        title={!isRunning ? 'Resume the campaign first to boost listings' : undefined}
                      >
                        {bState === 'running' ? 'Adding listings...' : bState === 'done' ? 'Listings added' : 'Add All Listings To This Campaign'}
                      </button>
                      <button
                        className={`btn btn-sm ${isRunning ? 'btn-ghost' : 'btn-gold'}`}
                        style={{ width: '100%', opacity: toggling ? 0.6 : 1 }}
                        disabled={toggling}
                        onClick={() => handleToggle(campaign)}
                      >
                        {toggling ? '…' : isRunning ? '⏸ Pause Campaign' : '▶ Resume Campaign'}
                      </button>
                    </div>
                  )}
                  {isEnded && (
                    <div style={{ fontSize: '12px', color: 'var(--dim)', textAlign: 'center', padding: '8px 0' }}>
                      This campaign has ended.
                    </div>
                  )}

                  {/* Campaign ID for reference */}
                  <div style={{ fontSize: '10px', color: 'var(--dim)', marginTop: '14px', fontFamily: 'monospace', opacity: 0.5 }}>
                    ID: {id}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Info section */}
        <div style={{ marginTop: '32px', padding: '20px 24px', borderRadius: '12px', background: 'rgba(14,165,233,0.05)', border: '1px solid rgba(14,165,233,0.12)' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--plat)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            How Promoted Listings Work
          </div>
          <div style={{ fontSize: '13px', color: 'var(--sil)', lineHeight: 1.75 }}>
            <strong style={{ color: 'var(--txt)' }}>Cost Per Sale only</strong> — you pay nothing for impressions or clicks. The ad fee (your set %) is only charged when a buyer clicks your promoted listing and purchases within 30 days.
            &nbsp;<strong style={{ color: 'var(--txt)' }}>Add All Listings To This Campaign</strong> adds every active listing in your store to the selected campaign at the campaign&apos;s ad rate.
            &nbsp;<strong style={{ color: 'var(--txt)' }}>Recommended rate: 3–7%</strong> for most categories. Higher rates win more placements but reduce margin.
          </div>
        </div>
      </div>
    </div>
  )
}
