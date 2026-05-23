import type { FinderProduct, ListProgress } from '../types'
import Image from 'next/image'
import { dashboardDisplayImageUrl } from '@/lib/dashboard-display-image'
import { TrialMeter } from './TrialMeter'
import { getBulkPreflightIssue } from '../utils'

type NicheCatalogItem = {
  name: string
  activeProducts: number
  publishReady: number
  needsEnrichment: number
  cacheProducts: number
  averageScore: number
  status: 'ready' | 'thin' | 'repairing'
  newestSeenAt: string | null
}

const NICHE_GROUPS = [
  { group: 'Trending', emoji: '\u2728', items: ['Golf Accessories', 'Pool Products', 'Beach & Sunny Day', 'Summer Outdoor Gear', 'Backyard & Patio', 'Travel Accessories', 'Fitness Recovery', 'Home Organization', 'Pet Products', 'Viral Gadgets', 'Giftable Under $50'] },
  { group: 'Electronics', emoji: '⚡', items: ['Phone Accessories', 'Computer Parts', 'Audio & Headphones', 'Smart Home Devices', 'Gaming Gear'] },
  { group: 'Home', emoji: '🏠', items: ['Kitchen Gadgets', 'Home Decor', 'Furniture & Lighting', 'Cleaning Supplies', 'Storage & Organization'] },
  { group: 'Outdoors', emoji: '🌿', items: ['Camping & Hiking', 'Garden & Tools', 'Sporting Goods', 'Fishing & Hunting', 'Cycling'] },
  { group: 'Health', emoji: '💪', items: ['Fitness Equipment', 'Personal Care', 'Supplements & Vitamins', 'Medical Supplies', 'Mental Wellness'] },
  { group: 'Automotive', emoji: '🚗', items: ['Car Parts', 'Car Accessories', 'Motorcycle Gear', 'Truck & Towing', 'Car Care'] },
  { group: 'Lifestyle', emoji: '✨', items: ['Pet Supplies', 'Baby & Kids', 'Toys & Games', 'Clothing & Accessories', 'Jewelry & Watches'] },
  { group: 'Business', emoji: '📦', items: ['Office Supplies', 'Industrial Equipment', 'Safety Gear', 'Janitorial & Cleaning', 'Packaging Materials'] },
  { group: 'Collectibles', emoji: '🏆', items: ['Trading Cards', 'Vintage & Antiques', 'Coins & Currency', 'Comics & Manga', 'Sports Memorabilia'] },
]

const NICHE_META = new Map(
  NICHE_GROUPS.flatMap((group) => group.items.map((item) => [item, { group: group.group, emoji: group.emoji }]))
)

const FALLBACK_NICHES: NicheCatalogItem[] = NICHE_GROUPS.flatMap((group) =>
  group.items.map((name) => ({
    name,
    activeProducts: 0,
    publishReady: 0,
    needsEnrichment: 0,
    cacheProducts: 0,
    averageScore: 0,
    status: 'repairing' as const,
    newestSeenAt: null,
  }))
)

function getNicheStatusCopy(status: NicheCatalogItem['status']) {
  if (status === 'ready') return 'Ready'
  if (status === 'thin') return 'Thin'
  return 'Repairing'
}

function getNicheStatusStyle(status: NicheCatalogItem['status']) {
  if (status === 'ready') return { color: 'var(--grn)', border: 'rgba(46,207,118,0.28)', background: 'rgba(46,207,118,0.10)' }
  if (status === 'thin') return { color: 'var(--gold)', border: 'rgba(199,160,82,0.30)', background: 'rgba(199,160,82,0.10)' }
  return { color: 'var(--sil)', border: 'rgba(125,211,252,0.14)', background: 'rgba(125,211,252,0.06)' }
}

function getNicheCatalogGroups(catalog: NicheCatalogItem[]) {
  const source = catalog.length > 0 ? catalog : FALLBACK_NICHES
  const deduped = Array.from(new Map(source.filter((item) => item.name && item.name !== 'Unassigned').map((item) => [item.name, item])).values())
  const statusOrder: Record<NicheCatalogItem['status'], number> = { ready: 0, thin: 1, repairing: 2 }
  const sorted = deduped.sort((a, b) =>
    statusOrder[a.status] - statusOrder[b.status] ||
    b.publishReady - a.publishReady ||
    b.activeProducts - a.activeProducts ||
    a.name.localeCompare(b.name)
  )
  return [
    { group: 'Ready', emoji: '✓', items: sorted.filter((item) => item.status === 'ready') },
    { group: 'Thin', emoji: '~', items: sorted.filter((item) => item.status === 'thin') },
    { group: 'Repairing', emoji: '...', items: sorted.filter((item) => item.status === 'repairing') },
  ].filter((group) => group.items.length > 0)
}

export function ProductListingTab({
  niche,
  nicheSaving,
  nicheCatalog,
  nicheCatalogLoading,
  nicheCatalogError,
  onSelectNiche,
  onClearNiche,
  finderLoading,
  finderResults,
  finderError,
  finderView,
  onFinderViewChange,
  onFindProducts,
  onShuffleResults,
  onOpenAsinLookup,
  onOpenScripts,
  onOpenListModal,
  onListAll,
  listAllProgress,
  connected,
  compact,
  trial,
}: {
  niche: string | null
  nicheSaving: boolean
  nicheCatalog: NicheCatalogItem[]
  nicheCatalogLoading: boolean
  nicheCatalogError: string | null
  onSelectNiche: (niche: string) => void
  onClearNiche: () => void
  finderLoading: boolean
  finderResults: FinderProduct[] | null
  finderError: string | null
  finderView: 'cards' | 'list'
  onFinderViewChange: (view: 'cards' | 'list') => void
  onFindProducts: () => void
  onShuffleResults: () => void
  onOpenAsinLookup: () => void
  onOpenScripts: () => void
  onOpenListModal: (product: FinderProduct) => void
  onListAll: () => void
  listAllProgress: ListProgress | null
  connected: boolean
  compact?: boolean
  trial?: { loading: boolean; plan: string; listed: number; trialLimit: number; trialRemaining?: number }
}) {
  const isListing = !!listAllProgress && listAllProgress.done < listAllProgress.total
  const listingDone = !!listAllProgress && listAllProgress.done === listAllProgress.total
  const failurePreview = listAllProgress?.failures?.slice(0, 3) || []
  const skippedCount = listAllProgress?.skipped || 0
  const failedCount = listAllProgress ? Math.max(0, listAllProgress.errors - skippedCount) : 0
  const listedCount = listAllProgress ? Math.max(0, listAllProgress.total - listAllProgress.errors) : 0
  const hasResults = Boolean(finderResults?.length)
  const publishReadyCount = finderResults?.filter((product) => !getBulkPreflightIssue(product)).length || 0
  const nicheCatalogGroups = getNicheCatalogGroups(nicheCatalog)
  const activeNicheMeta = niche ? NICHE_META.get(niche) : null
  const activeNicheStats = niche ? nicheCatalog.find((item) => item.name === niche) : null
  const trialLocked = Boolean(
    trial &&
    !trial.loading &&
    trial.plan === 'trial' &&
    (trial.trialRemaining ?? Math.max(0, trial.trialLimit - trial.listed)) <= 0
  )

  return (
    <div style={{ animation: 'fadein 0.22s ease' }}>

      {/* Header */}
      <div style={{ padding: compact ? '22px var(--xpad) 16px' : '40px var(--xpad) 28px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase', color: 'var(--plat)', marginBottom: '8px' }}>
          {compact ? 'List' : 'StackPilot / Strategy'}
        </div>
        <div style={{ fontFamily: 'var(--serif)', fontSize: compact ? '26px' : '36px', fontWeight: 700, color: 'var(--txt)', lineHeight: 1.1, marginBottom: '10px' }}>
          {compact ? 'Products' : 'Product Listing'}
        </div>
        <div style={{ fontSize: compact ? '12px' : '13px', color: 'var(--sil)', lineHeight: 1.6, maxWidth: '540px' }}>
          {niche
            ? `Sourcing profitable products for ${niche}. Find items, review the numbers, and list directly to eBay in one click.`
            : 'Pick a category below to start sourcing. We\'ll scan Amazon for profitable products you can list on eBay right now.'}
        </div>
        {trial ? (
          <div style={{ marginTop: compact ? '14px' : '18px', maxWidth: '520px' }}>
            <TrialMeter
              variant={compact ? 'compact' : 'full'}
              loading={trial.loading}
              plan={trial.plan}
              listed={trial.listed}
              trialLimit={trial.trialLimit}
              trialRemaining={trial.trialRemaining}
            />
          </div>
        ) : null}
      </div>

      <div style={{ padding: '0 var(--xpad) 44px' }}>
        {/* Active niche banner */}
        {niche ? (
          <div style={{ marginBottom: '24px', padding: '16px 22px', borderRadius: '14px', background: 'linear-gradient(135deg,rgba(14,165,233,0.14),rgba(20,184,166,0.08))', border: '1px solid rgba(125,211,252,0.20)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(14,165,233,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0 }}>
                {NICHE_GROUPS.find(g => g.items.includes(niche))?.emoji || '🛒'}
              </div>
              <div>
                <div style={{ fontSize: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--sil)', marginBottom: '3px' }}>{activeNicheMeta?.group || 'Active'} Niche</div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: '20px', fontWeight: 600, color: 'var(--gld2)' }}>{niche}</div>
                {activeNicheStats ? (
                  <div style={{ fontSize: '10px', color: 'var(--sil)', marginTop: '3px' }}>
                    {activeNicheStats.publishReady} publish-ready · {activeNicheStats.needsEnrichment} need enrichment
                  </div>
                ) : null}
              </div>
            </div>
            <button onClick={onClearNiche} className="btn btn-ghost btn-sm" style={{ fontSize: '11px' }}>Change Niche</button>
          </div>
        ) : (
          /* Niche selector */
          <div className="card" style={{ padding: '32px', marginBottom: '28px' }}>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--txt)', marginBottom: '6px' }}>Choose Your Niche</div>
            <div style={{ fontSize: '12px', color: 'var(--dim)', marginBottom: '12px', lineHeight: 1.6 }}>
              Pick one category to focus on. Ready niches have 45+ publish-ready products, Thin niches have 30-44, and Repairing niches are still being stocked or enriched.
            </div>
            {nicheCatalogLoading ? (
              <div style={{ color: 'var(--sil)', fontSize: '12px', marginBottom: '16px' }}>Loading live niche counts...</div>
            ) : nicheCatalogError ? (
              <div style={{ color: 'var(--gold)', fontSize: '12px', marginBottom: '16px' }}>Live niche counts unavailable. Showing the built-in niche list.</div>
            ) : (
              <div style={{ color: 'var(--sil)', fontSize: '11px', marginBottom: '16px' }}>
                Showing {nicheCatalog.length || FALLBACK_NICHES.length} source niches from the live product pool.
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: '20px' }}>
              {nicheCatalogGroups.map(group => (
                <div key={group.group}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
                    <span style={{ fontSize: '14px' }}>{group.emoji}</span>
                    <span style={{ fontSize: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--plat)' }}>{group.group}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {group.items.map(item => {
                      const statusStyle = getNicheStatusStyle(item.status)
                      const meta = NICHE_META.get(item.name)
                      return (
                      <button
                        key={item.name}
                        onClick={() => onSelectNiche(item.name)}
                        disabled={nicheSaving}
                        style={{
                          textAlign: 'left',
                          padding: '10px 12px',
                          borderRadius: '9px',
                          fontSize: '12px',
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                          border: '1px solid rgba(14,116,144,0.12)',
                          background: 'rgba(14,27,44,0.72)',
                          color: 'var(--sil)',
                          transition: 'all 0.15s',
                          fontWeight: 500,
                        }}
                        onMouseEnter={e => { (e.target as HTMLButtonElement).style.background = 'rgba(14,165,233,0.10)'; (e.target as HTMLButtonElement).style.borderColor = 'rgba(14,165,233,0.24)'; (e.target as HTMLButtonElement).style.color = 'var(--plat)' }}
                        onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = 'rgba(14,27,44,0.72)'; (e.target as HTMLButtonElement).style.borderColor = 'rgba(14,116,144,0.12)'; (e.target as HTMLButtonElement).style.color = 'var(--sil)' }}
                      >
                        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {meta?.emoji ? `${meta.emoji} ` : ''}{item.name}
                          </span>
                          <span style={{ flexShrink: 0, fontSize: '9px', color: statusStyle.color, border: `1px solid ${statusStyle.border}`, background: statusStyle.background, borderRadius: '999px', padding: '2px 6px', fontWeight: 800 }}>
                            {getNicheStatusCopy(item.status)}
                          </span>
                        </span>
                        <span style={{ display: 'block', marginTop: '4px', color: 'var(--dim)', fontSize: '10px' }}>
                          {item.publishReady} ready · {item.needsEnrichment} enriching
                        </span>
                      </button>
                    )})}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {niche ? (
          <>
            {/* Not connected warning */}
            {!connected ? (
              <div style={{ marginBottom: '20px', padding: '14px 18px', borderRadius: '12px', background: 'rgba(232,63,80,0.07)', border: '1px solid rgba(232,63,80,0.18)', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--red)', marginTop: '4px', flexShrink: 0 }} />
                <div style={{ fontSize: '12px', color: 'var(--sil)', lineHeight: 1.6 }}>
                  eBay isn't connected yet — you can still browse products, but the <strong style={{ color: 'var(--txt)' }}>Publish to eBay</strong> button won't work until you connect your account in Settings.
                </div>
              </div>
            ) : null}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
              <button
                className="btn btn-gold"
                disabled={finderLoading}
                onClick={onFindProducts}
                style={{ padding: '13px 22px', fontSize: '13px', fontWeight: 700, flex: '1 1 160px' }}
              >
                {finderLoading ? '🔍 Scanning Amazon...' : '🔍 Find Products'}
              </button>
              {hasResults && !finderLoading && !isListing ? (
                <button
                  className="btn btn-ghost"
                  onClick={onShuffleResults}
                  style={{ padding: '13px 18px', fontSize: '12px' }}
                >
                  Shuffle Results
                </button>
              ) : null}
              {finderResults && finderResults.length > 0 && !isListing ? (
                <button
                  className="btn btn-solid"
                  onClick={onListAll}
                  disabled={!connected || trialLocked || publishReadyCount === 0}
                  style={{ padding: '13px 22px', fontSize: '13px', fontWeight: 700, flex: '1 1 140px' }}
                >
                  List Ready ({publishReadyCount})
                </button>
              ) : null}
              {isListing ? (
                <div style={{ padding: '13px 18px', borderRadius: '10px', background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.22)', fontSize: '12px', color: 'var(--plat)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 140px' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--gold)', animation: 'glow-pulse 1.2s ease infinite' }} />
                  Listing {listAllProgress!.done + 1} of {listAllProgress!.total}...
                </div>
              ) : null}
              {listingDone ? (
                <div style={{ padding: '13px 18px', borderRadius: '10px', background: 'rgba(46,207,118,0.08)', border: '1px solid rgba(46,207,118,0.2)', fontSize: '12px', color: 'var(--grn)', fontWeight: 600, flex: '1 1 140px' }}>
                  Done: {listedCount} listed{skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}{failedCount > 0 ? ` · ${failedCount} failed` : ''}
                </div>
              ) : null}
              {compact ? null : (
                <>
                  <button className="btn btn-ghost" onClick={onOpenAsinLookup} style={{ padding: '13px 18px', fontSize: '12px' }}>
                    ASIN Lookup
                  </button>
                  <button className="btn btn-ghost" onClick={onOpenScripts} style={{ padding: '13px 18px', fontSize: '12px' }}>
                    Scripts
                  </button>
                </>
              )}
            </div>

            {/* Error */}
            {finderError ? (
              <div style={{ marginBottom: '20px', padding: '14px 16px', borderRadius: '10px', background: 'rgba(232,63,80,0.07)', border: '1px solid rgba(232,63,80,0.18)', fontSize: '12px', color: 'var(--red)', lineHeight: 1.6 }}>
                {finderError}
              </div>
            ) : null}

            {listingDone && failurePreview.length > 0 ? (
              <div style={{ marginBottom: '20px', padding: '14px 16px', borderRadius: '10px', background: 'rgba(199,160,82,0.08)', border: '1px solid rgba(199,160,82,0.22)', fontSize: '12px', color: 'var(--sil)', lineHeight: 1.6 }}>
                <div style={{ color: 'var(--gold)', fontWeight: 800, marginBottom: '6px' }}>Skipped or failed items were removed and replaced.</div>
                {failurePreview.map((failure) => (
                  <div key={`${failure.asin}-${failure.code}`}>{failure.asin}: {failure.message}</div>
                ))}
              </div>
            ) : null}

            {/* Loading */}
            {finderLoading ? (
              <div className="card" style={{ padding: '60px', textAlign: 'center' }}>
                <div style={{ fontSize: '28px', marginBottom: '16px' }}>🔍</div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--txt)', marginBottom: '6px' }}>Scanning Amazon for {niche} products...</div>
                <div style={{ fontSize: '12px', color: 'var(--dim)', lineHeight: 1.6 }}>
                  Checking prices, profit margins, and availability. Usually takes about 15 seconds.
                </div>
              </div>
            ) : null}

            {/* No results */}
            {finderResults && finderResults.length === 0 && !finderLoading ? (
              <div className="card" style={{ padding: '48px', textAlign: 'center' }}>
                <div style={{ fontSize: '28px', marginBottom: '14px' }}>📭</div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--txt)', marginBottom: '6px' }}>No matching products found</div>
                <div style={{ fontSize: '12px', color: 'var(--dim)', lineHeight: 1.6, maxWidth: '360px', margin: '0 auto' }}>
                  No products met the profit criteria for {niche} right now. Try again later or switch to a different niche.
                </div>
              </div>
            ) : null}

            {/* Results */}
            {finderResults && finderResults.length > 0 && !finderLoading ? (
              <FinderResults
                connected={connected}
                niche={niche}
                results={finderResults}
                view={finderView}
                onViewChange={onFinderViewChange}
                onOpenListModal={onOpenListModal}
                onListAll={onListAll}
                listAllProgress={listAllProgress}
                compact={compact}
                trialLocked={trialLocked}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

export function FinderResults({
  connected,
  niche,
  results,
  view,
  onViewChange,
  onOpenListModal,
  onListAll,
  listAllProgress,
  compact,
  trialLocked,
}: {
  connected: boolean
  niche: string
  results: FinderProduct[]
  view: 'cards' | 'list'
  onViewChange: (view: 'cards' | 'list') => void
  onOpenListModal: (product: FinderProduct) => void
  onListAll: () => void
  listAllProgress: ListProgress | null
  compact?: boolean
  trialLocked?: boolean
}) {
  const isListing = !!listAllProgress && listAllProgress.done < listAllProgress.total
  const listingDone = !!listAllProgress && listAllProgress.done === listAllProgress.total
  const failurePreview = listAllProgress?.failures?.slice(0, 3) || []
  const skippedCount = listAllProgress?.skipped || 0
  const failedCount = listAllProgress ? Math.max(0, listAllProgress.errors - skippedCount) : 0
  const listedCount = listAllProgress ? Math.max(0, listAllProgress.total - listAllProgress.errors) : 0
  const publishReadyCount = results.filter((product) => !getBulkPreflightIssue(product)).length
  const candidateCount = Math.max(0, results.length - publishReadyCount)

  return (
    <div>
      {/* Results toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <div style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--plat)' }}>
            {results.length} products — {niche}
          </div>
          {compact ? (
            <div style={{ fontSize: '10px', color: 'var(--dim)', marginTop: '3px' }}>
              {publishReadyCount} publish-ready{candidateCount > 0 ? ` · ${candidateCount} still checking` : ''}
            </div>
          ) : (
            <div style={{ fontSize: '10px', color: 'var(--dim)', marginTop: '3px' }}>
              Stable queue · Use Shuffle to reshuffle · Click any card to review before publishing
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {!isListing && !listingDone ? (
            <button className="btn btn-gold btn-sm" style={{ fontSize: '10px' }} disabled={!connected || trialLocked || publishReadyCount === 0} onClick={onListAll}>
              List Ready ({publishReadyCount})
            </button>
          ) : null}
          {isListing ? (
            <div style={{ fontSize: '11px', color: 'var(--plat)', padding: '5px 12px', borderRadius: '8px', background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.22)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: 'var(--gold)', animation: 'glow-pulse 1.2s ease infinite' }} />
              {listAllProgress!.done + 1}/{listAllProgress!.total}
            </div>
          ) : null}
          {listingDone ? (
            <div style={{ fontSize: '11px', color: 'var(--grn)', padding: '5px 12px', borderRadius: '8px', background: 'rgba(46,207,118,0.08)', border: '1px solid rgba(46,207,118,0.2)' }}>
              Done: {listedCount} listed{skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}{failedCount > 0 ? ` · ${failedCount} failed` : ''}
            </div>
          ) : null}
          {(['cards', 'list'] as const).map(opt => (
            <button
              key={opt}
              onClick={() => onViewChange(opt)}
              style={{ padding: '5px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 0, border: view === opt ? '1px solid rgba(14,165,233,0.35)' : '1px solid rgba(125,211,252,0.14)', background: view === opt ? 'rgba(14,165,233,0.14)' : 'rgba(14,27,44,0.72)', color: view === opt ? 'var(--plat)' : 'var(--sil)' }}
            >
              {opt === 'cards' ? '⊞' : '☰'} {opt}
            </button>
          ))}
        </div>
      </div>

      {listingDone && failurePreview.length > 0 ? (
        <div style={{ marginBottom: '14px', padding: '12px 14px', borderRadius: '10px', background: 'rgba(199,160,82,0.08)', border: '1px solid rgba(199,160,82,0.2)', color: 'var(--sil)', fontSize: '12px', lineHeight: 1.55 }}>
          <strong style={{ color: 'var(--gold)' }}>Preflight/listing notes:</strong>{' '}
          {failurePreview.map((failure) => `${failure.asin}: ${failure.message}`).join(' ')}
        </div>
      ) : null}

      {view === 'cards' ? (
        <div style={{ display: 'grid', gridTemplateColumns: compact ? 'repeat(auto-fill,minmax(260px,1fr))' : 'repeat(auto-fill,minmax(300px,1fr))', gap: '14px' }}>
          {results.map(product => (
            <ProductCard key={product.asin} product={product} onOpenListModal={onOpenListModal} />
          ))}
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'rgba(15,35,56,0.92)', borderBottom: '1px solid rgba(125,211,252,0.12)' }}>
                {['Product', 'Buy on Amazon', 'Sell on eBay', 'Profit', 'ROI', 'Risk', ''].map(h => (
                  <th key={h} style={{ color: 'var(--plat)', fontSize: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, padding: '12px 14px', textAlign: h === 'Product' ? 'left' : 'center', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.map((product, i) => (
                <tr key={product.asin} style={{ background: i % 2 === 0 ? 'rgba(14,27,44,0.88)' : 'rgba(11,22,36,0.88)', borderBottom: '1px solid rgba(125,211,252,0.08)' }}>
                  <td style={{ padding: '12px 14px', maxWidth: '280px' }}>
                    <div style={{ fontSize: '12px', color: 'var(--txt)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{product.title}</div>
                    <div style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--dim)', marginTop: '2px' }}>{product.asin}</div>
                  </td>
                  <td style={{ padding: '12px 14px', textAlign: 'center', fontFamily: 'Space Grotesk,sans-serif', fontWeight: 700, fontSize: '12px', color: 'var(--txt)' }}>${product.amazonPrice.toFixed(2)}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'center', fontFamily: 'Space Grotesk,sans-serif', fontWeight: 700, fontSize: '12px', color: 'var(--gld2)' }}>${product.ebayPrice.toFixed(2)}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'center', fontFamily: 'Space Grotesk,sans-serif', fontWeight: 700, fontSize: '12px', color: 'var(--grn)' }}>${product.profit.toFixed(2)}</td>
                  <td style={{ padding: '12px 14px', textAlign: 'center', fontFamily: 'Space Grotesk,sans-serif', fontWeight: 700, fontSize: '12px', color: product.roi >= 50 ? 'var(--grn)' : 'var(--gold)' }}>{product.roi}%</td>
                  <td style={{ padding: '12px 14px', textAlign: 'center' }}><RiskBadge risk={product.risk} /></td>
                  <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                    <button onClick={() => onOpenListModal(product)} className="btn btn-gold btn-sm" style={{ fontSize: '10px', padding: '5px 12px' }}>
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ProductCard({ product, onOpenListModal }: { product: FinderProduct; onOpenListModal: (p: FinderProduct) => void }) {
  const accentColor = product.risk === 'LOW' ? 'rgba(46,207,118,0.6)' : product.risk === 'MEDIUM' ? 'rgba(14,165,233,0.6)' : 'rgba(232,63,80,0.5)'
  const thumbSrc = dashboardDisplayImageUrl(product.imageUrl)

  return (
    <div className="card" style={{ padding: '0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {/* Accent top bar */}
      <div style={{ height: '3px', background: `linear-gradient(90deg, ${accentColor}, transparent)` }} />

      <div style={{ padding: '18px 18px 16px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Image + title */}
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '14px' }}>
          {thumbSrc ? (
            <Image
              src={thumbSrc}
              alt={product.title}
              width={54}
              height={54}
              unoptimized
              referrerPolicy="no-referrer"
              style={{
                width: '54px',
                height: '54px',
                objectFit: 'contain',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.10)',
                border: '1px solid rgba(125,211,252,0.12)',
                flexShrink: 0,
              }}
            />
          ) : (
            <div style={{ width: '54px', height: '54px', borderRadius: '8px', background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(125,211,252,0.12)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px' }}>📦</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--txt)', lineHeight: 1.4, marginBottom: '4px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{product.title}</div>
            <div style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--dim)' }}>{product.asin}</div>
          </div>
        </div>

        {/* Key numbers */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px' }}>
          <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(125,211,252,0.08)', border: '1px solid rgba(125,211,252,0.12)' }}>
            <div style={{ fontSize: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--sil)', marginBottom: '4px' }}>Buy on Amazon</div>
            <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: '16px', fontWeight: 800, color: 'var(--txt)' }}>${product.amazonPrice.toFixed(2)}</div>
          </div>
          <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(125,211,252,0.08)', border: '1px solid rgba(125,211,252,0.12)' }}>
            <div style={{ fontSize: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--sil)', marginBottom: '4px' }}>Sell on eBay</div>
            <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: '16px', fontWeight: 800, color: 'var(--gld2)' }}>${product.ebayPrice.toFixed(2)}</div>
          </div>
          <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.16)' }}>
            <div style={{ fontSize: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--sil)', marginBottom: '4px' }}>Your Profit</div>
            <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: '18px', fontWeight: 800, color: 'var(--grn)' }}>${product.profit.toFixed(2)}</div>
          </div>
          <div style={{ padding: '10px', borderRadius: '8px', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.16)' }}>
            <div style={{ fontSize: '8px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0, color: 'var(--sil)', marginBottom: '4px' }}>ROI</div>
            <div style={{ fontFamily: 'Space Grotesk,sans-serif', fontSize: '18px', fontWeight: 800, color: product.roi >= 50 ? 'var(--grn)' : 'var(--gold)' }}>{product.roi}%</div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginTop: 'auto' }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <RiskBadge risk={product.risk} />
            {product.salesVolume ? <span style={{ fontSize: '9px', color: 'var(--dim)' }}>{product.salesVolume} sold</span> : null}
          </div>
          <button onClick={() => onOpenListModal(product)} className="btn btn-gold btn-sm" style={{ fontSize: '11px', padding: '7px 14px', fontWeight: 700, whiteSpace: 'nowrap' }}>
            Review & List →
          </button>
        </div>
      </div>
    </div>
  )
}

function RiskBadge({ risk }: { risk: string }) {
  const isLow = risk === 'LOW'
  const isMed = risk === 'MEDIUM'
  const tone = isLow ? 'var(--grn)' : isMed ? 'var(--gold)' : 'var(--red)'
  const bg = isLow ? 'rgba(46,207,118,0.10)' : isMed ? 'rgba(14,165,233,0.10)' : 'rgba(232,63,80,0.10)'
  const border = isLow ? 'rgba(46,207,118,0.25)' : isMed ? 'rgba(14,165,233,0.25)' : 'rgba(232,63,80,0.25)'
  const label = isLow ? '✓ Low Risk' : isMed ? '~ Medium' : '⚠ High Risk'

  return (
    <span style={{ fontSize: '8px', padding: '2px 8px', borderRadius: '20px', fontWeight: 700, background: bg, color: tone, border: `1px solid ${border}`, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}
