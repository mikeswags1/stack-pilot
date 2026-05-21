'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { signOut, useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { DashboardSidebar } from './components/DashboardSidebar'
import { DashboardBanner, DashboardTopbar } from './components/DashboardTopbar'
import { OverviewTab } from './components/OverviewTab'
import { OrdersTab } from './components/OrdersTab'
import { FinancialsTab } from './components/FinancialsTab'
import { PerformanceTab } from './components/PerformanceTab'
import { ScriptsTab } from './components/ScriptsTab'
import { AsinLookupTab } from './components/AsinLookupTab'
import { FulfillmentTab } from './components/FulfillmentTab'
import { ProductListingTab } from './components/ProductListingTab'
import { ContinuousListingTab } from './components/ContinuousListingTab'
import { CampaignsTab } from './components/CampaignsTab'
import { SettingsTab } from './components/SettingsTab'
import { CompactBottomNav } from './components/CompactBottomNav'
import { CompactPwaTopbar } from './components/CompactPwaTopbar'
import { CompactPwaMenu } from './components/CompactPwaMenu'
import { CompactHomeTab } from './components/CompactHomeTab'
import { CompactMoreTab } from './components/CompactMoreTab'
import { CompactDesktopHint } from './components/CompactDesktopHint'
import { SellOnEbayModal } from './components/SellOnEbayModal'
import { GetTheAppBanner } from '@/app/components/GetTheAppBanner'
import { useCompactDashboard } from './hooks/useCompactDashboard'
import type { BannerState, EbayCredentialsSummary, FinancialItem, FinancialSummary, FinderProduct, ListProgress, OrderAsinMap, PerformanceData, ProductSourceHealth, ScriptMessage, Tab } from './types'

const TAB_QUERY_KEYS = new Set<Tab>([
  'overview',
  'orders',
  'fulfillment',
  'financials',
  'performance',
  'scripts',
  'asin',
  'product',
  'continuous',
  'campaigns',
  'settings',
  'more',
])
import type { AsinResult, EbayOrder, ListResult } from './types'
import {
  disconnectEbay,
  fetchFinancials,
  fetchPerformance,
  fetchEbayCredentials,
  fetchFinderProducts,
  fetchOrderAsinMap,
  fetchOrders,
  fetchProductSourceHealth,
  fetchUserNiche,
  DashboardApiError,
  getErrorMessage,
  isReconnectError,
  lookupAsinByItemId,
  publishProduct,
  runDashboardScript,
  saveManualAsinMapping,
  saveUserNiche,
  validateAmazonAsin,
  fetchSubscriptionStatus,
} from './api'
import { EBAY_FEE_RATE } from './constants'
import { getBulkPreflightIssue, getGrossRevenue, getListingPreview, getRecommendedEbayPrice, listProductsInBatches, parseDashboardSearchMessage, summarizeBulkListResult } from './utils'
import { isRefundedOrder } from './order-status'

type ConnectionState = {
  ebayConnected: boolean
  ebayNeedsReconnect: boolean
  syncing: boolean
}

type SubscriptionState = {
  loading: boolean
  plan: string
  status: string
  trialLimit: number
  listed: number
  trialRemaining: number
  isPro: boolean
  billingCheckoutAvailable: boolean
  billingPortalAvailable: boolean
  billingOwnerBypass: boolean
}

type OrderState = {
  orders: EbayOrder[]
  awaiting: EbayOrder[]
  syncTime: string | null
  orderAsinMap: OrderAsinMap
}

type FinancialState = {
  loading: boolean
  summary: FinancialSummary | null
  items: FinancialItem[]
  error: string | null
}

type PerformanceState = {
  loading: boolean
  data: PerformanceData | null
  error: string | null
}

type ProductSourceHealthState = {
  loading: boolean
  data: ProductSourceHealth | null
  error: string | null
}

type NicheState = {
  value: string | null
  saving: boolean
  saved: boolean
}

type LookupState = {
  input: string
  manualAsin: string
  rejectedAsins: string[]
  result: AsinResult | null
  loading: boolean
  savingManual: boolean
  error: string | null
}

type FinderState = {
  loading: boolean
  results: FinderProduct[] | null
  error: string | null
  view: 'cards' | 'list'
  listAllProgress: ListProgress | null
}

type ListingState = {
  modal: FinderProduct | null
  price: string
  validating: boolean
  validated: boolean
  loading: boolean
  result: ListResult | null
  error: string | null
}

const FINDER_STOCK_TARGET = 30
const FINDER_ROTATION_POOL_TARGET = 90

function tagFinderProducts(products: FinderProduct[], sourceMode: 'niche' | 'continuous') {
  return products.map((product) => ({ ...product, sourceMode }))
}

function getStableShuffleScore(product: FinderProduct, tick: number, index: number) {
  const text = `${product.asin}:${product.sourceNiche || ''}:${tick}:${index}`
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function getPublishReadyFinderProducts(products: FinderProduct[]) {
  return products.filter((product) => !getBulkPreflightIssue(product))
}

function getRotatingFinderProducts(products: FinderProduct[] | null, tick: number, limit = FINDER_STOCK_TARGET) {
  if (!products) return null
  const publishReadyProducts = getPublishReadyFinderProducts(products)
  const readyAsins = new Set(publishReadyProducts.map((product) => product.asin.toUpperCase()))
  const pool = publishReadyProducts.length > 0
    ? [
        ...publishReadyProducts,
        ...products.filter((product) => !readyAsins.has(product.asin.toUpperCase())),
      ]
    : products
  if (pool.length <= 1) return pool
  if (tick === 0) return pool.slice(0, limit)
  return [...pool]
    .map((product, index) => ({ product, score: getStableShuffleScore(product, tick, index) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.product)
}

function mergeRefilledProducts(current: FinderProduct[] | null, incoming: FinderProduct[], listedAsins: string[], sourceMode: 'niche' | 'continuous') {
  const listed = new Set(listedAsins.map((asin) => asin.toUpperCase()))
  const kept = (current || []).filter((product) => !listed.has(product.asin.toUpperCase()))
  const seen = new Set(kept.map((product) => product.asin.toUpperCase()))
  const additions = incoming.filter((product) => {
    const asin = product.asin.toUpperCase()
    if (listed.has(asin) || seen.has(asin)) return false
    seen.add(asin)
    return true
  })

  // If incoming added nothing new (pool completely exhausted / all duplicates),
  // use the incoming list as a fresh replacement rather than leaving the user with
  // an empty or stale queue. This is the self-heal: after the pool is exhausted the
  // API returns fresh products (via live-fill / scrape) and we surface them directly.
  if (additions.length === 0 && incoming.length > 0 && kept.length < FINDER_STOCK_TARGET) {
    const freshAdditions = incoming.filter((product) => !listed.has(product.asin.toUpperCase()))
    console.info('[mergeRefilled] pool exhausted — using incoming as fresh replacement', { incomingCount: freshAdditions.length })
    return tagFinderProducts([...kept, ...freshAdditions].slice(0, FINDER_ROTATION_POOL_TARGET), sourceMode)
  }

  return tagFinderProducts([...kept, ...additions].slice(0, FINDER_ROTATION_POOL_TARGET), sourceMode)
}

export default function Dashboard() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const compact = useCompactDashboard()

  const [tab, setTab] = useState<Tab>('overview')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [pwaMenuOpen, setPwaMenuOpen] = useState(false)
  const [banner, setBanner] = useState<BannerState | null>(null)
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionState>({
    loading: true,
    plan: 'trial',
    status: 'active',
    trialLimit: 5,
    listed: 0,
    trialRemaining: 5,
    isPro: false,
    billingCheckoutAvailable: false,
    billingPortalAvailable: false,
    billingOwnerBypass: false,
  })
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    ebayConnected: false,
    ebayNeedsReconnect: false,
    syncing: false,
  })
  const [disconnectingEbay, setDisconnectingEbay] = useState(false)
  const [orderState, setOrderState] = useState<OrderState>({
    orders: [],
    awaiting: [],
    syncTime: null,
    orderAsinMap: {},
  })
  const [financialState, setFinancialState] = useState<FinancialState>({
    loading: false,
    summary: null,
    items: [],
    error: null,
  })
  const [performanceState, setPerformanceState] = useState<PerformanceState>({
    loading: false,
    data: null,
    error: null,
  })
  const [sourceHealthState, setSourceHealthState] = useState<ProductSourceHealthState>({
    loading: false,
    data: null,
    error: null,
  })
  const [financialPeriod, setFinancialPeriod] = useState('30d')
  const [nicheState, setNicheState] = useState<NicheState>({
    value: null,
    saving: false,
    saved: false,
  })
  const [lookupState, setLookupState] = useState<LookupState>({
    input: '',
    manualAsin: '',
    rejectedAsins: [],
    result: null,
    loading: false,
    savingManual: false,
    error: null,
  })
  const [finderState, setFinderState] = useState<FinderState>({
    loading: false,
    results: null,
    error: null,
    view: 'cards',
    listAllProgress: null,
  })
  const [continuousFinderState, setContinuousFinderState] = useState<FinderState>({
    loading: false,
    results: null,
    error: null,
    view: 'cards',
    listAllProgress: null,
  })
  const [listingState, setListingState] = useState<ListingState>({
    modal: null,
    price: '',
    validating: false,
    validated: false,
    loading: false,
    result: null,
    error: null,
  })
  const [scriptRunning, setScriptRunning] = useState<string | null>(null)
  const [scriptMessage, setScriptMessage] = useState<ScriptMessage | null>(null)
  // Start at 1 so the initial display is already shuffled (tick=0 would always show
  // the same deterministic first-30 slice — no variety for the user on first load).
  const [finderRotationTick, setFinderRotationTick] = useState(1)

  const visibleFinderResults = useMemo(() => {
    const rotated = getRotatingFinderProducts(finderState.results, finderRotationTick)
    // Hard cap: never show more than FINDER_STOCK_TARGET (30) products at once.
    return rotated ? rotated.slice(0, FINDER_STOCK_TARGET) : null
  }, [finderRotationTick, finderState.results])

  const visibleContinuousResults = useMemo(() => {
    const rotated = getRotatingFinderProducts(continuousFinderState.results, finderRotationTick)
    return rotated ? rotated.slice(0, FINDER_STOCK_TARGET) : null
  }, [continuousFinderState.results, finderRotationTick])

  const replaceUnavailableProduct = useCallback(
    async (product: FinderProduct) => {
      const removeAsins = [product.asin]
      const listed = new Set(removeAsins.map((asin) => asin.toUpperCase()))
      const sourceMode = product.sourceMode === 'continuous' ? 'continuous' : 'niche'

      if (sourceMode === 'continuous') {
        setContinuousFinderState((prev) => ({
          ...prev,
          results: prev.results ? prev.results.filter((entry) => !listed.has(entry.asin.toUpperCase())) : prev.results,
        }))

        const remainingAsins = (continuousFinderState.results || [])
          .filter((entry) => !listed.has(entry.asin.toUpperCase()))
          .map((entry) => entry.asin)

        try {
          const refreshed = await fetchFinderProducts('', true, {
            mode: 'continuous',
            limit: FINDER_ROTATION_POOL_TARGET,
            excludeAsins: [...remainingAsins, ...removeAsins],
          })
          setContinuousFinderState((prev) => ({
            ...prev,
            results: mergeRefilledProducts(prev.results || continuousFinderState.results, refreshed.results || [], removeAsins, 'continuous'),
          }))
        } catch {
          setContinuousFinderState((prev) => ({
            ...prev,
            results: prev.results ? prev.results.filter((entry) => !listed.has(entry.asin.toUpperCase())) : prev.results,
          }))
        }
        return
      }

      setFinderState((prev) => ({
        ...prev,
        results: prev.results ? prev.results.filter((entry) => !listed.has(entry.asin.toUpperCase())) : prev.results,
      }))

      if (!nicheState.value) return
      const remainingAsins = (finderState.results || [])
        .filter((entry) => !listed.has(entry.asin.toUpperCase()))
        .map((entry) => entry.asin)

      try {
        const refreshed = await fetchFinderProducts(nicheState.value, true, {
          limit: FINDER_ROTATION_POOL_TARGET,
          excludeAsins: [...remainingAsins, ...removeAsins],
        })
        setFinderState((prev) => ({
          ...prev,
          results: mergeRefilledProducts(prev.results || finderState.results, refreshed.results || [], removeAsins, 'niche'),
        }))
      } catch {
        setFinderState((prev) => ({
          ...prev,
          results: prev.results ? prev.results.filter((entry) => !listed.has(entry.asin.toUpperCase())) : prev.results,
        }))
      }
    },
    [continuousFinderState.results, finderState.results, nicheState.value]
  )

  const validateListingProduct = useCallback(async (product: FinderProduct) => {
    const originalPrice = product.ebayPrice.toFixed(2)

    setListingState((prev) => {
      if (!prev.modal || prev.modal.asin !== product.asin) return prev
      return { ...prev, validating: true, error: null }
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const validated = await validateAmazonAsin(product.asin)
        const resolvedImageUrl = validated.imageUrl || product.imageUrl || validated.images?.[0]
        const hasValidAmazonData = Boolean(resolvedImageUrl && validated.amazonPrice > 0)

        if (validated.available === false) {
          const message = 'This Amazon source is currently unavailable, so StackPilot removed it from the queue and is pulling a replacement.'
          setListingState((prev) => {
            if (!prev.modal || prev.modal.asin !== product.asin) return prev
            return {
              ...prev,
              modal: { ...product, available: false },
              validating: false,
              validated: false,
              error: message,
            }
          })
          setBanner({ tone: 'error', text: message })
          void replaceUnavailableProduct(product)
          return { validated: false as const, product, unavailable: true as const }
        }

        if (!hasValidAmazonData) {
          throw new Error('INCOMPLETE_AMAZON_VALIDATION')
        }

        const nextRecommendedPrice = getRecommendedEbayPrice(validated.amazonPrice)
        const preview = getListingPreview(nextRecommendedPrice.toFixed(2), validated.amazonPrice, '0', EBAY_FEE_RATE)
        const nextProduct: FinderProduct = {
          ...product,
          title: validated.title,
          amazonPrice: validated.amazonPrice,
          ebayPrice: nextRecommendedPrice,
          profit: preview.profit,
          roi: preview.roi,
          imageUrl: resolvedImageUrl || product.imageUrl,
          images: (validated.images && validated.images.length > 0 ? validated.images : product.images) || product.images,
          features: validated.features || product.features,
          description: validated.description || product.description,
          specs: validated.specs || product.specs,
          available: validated.available,
        }

        setFinderState((prev) => ({
          ...prev,
          results: prev.results
            ? prev.results.map((entry) => (entry.asin === product.asin ? nextProduct : entry))
            : prev.results,
        }))
        setContinuousFinderState((prev) => ({
          ...prev,
          results: prev.results
            ? prev.results.map((entry) => (entry.asin === product.asin ? nextProduct : entry))
            : prev.results,
        }))

        setListingState((prev) => {
          if (!prev.modal || prev.modal.asin !== product.asin) return prev

          const shouldRefreshPrice = prev.price === originalPrice
          return {
            ...prev,
            modal: nextProduct,
            price: shouldRefreshPrice ? nextRecommendedPrice.toFixed(2) : prev.price,
            validating: false,
            validated: true,
            error: null,
          }
        })

        return { validated: true, product: nextProduct }
      } catch {
        if (attempt === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 500))
          continue
        }
      }
    }

    const message = 'Amazon validation did not finish cleanly, so StackPilot removed this product from the queue and is pulling a replacement.'
    setListingState((prev) => {
      if (!prev.modal || prev.modal.asin !== product.asin) return prev
      return {
        ...prev,
        modal: { ...product, available: false },
        validating: false,
        validated: false,
        error: message,
      }
    })
    setBanner({ tone: 'error', text: message })
    void replaceUnavailableProduct(product)

    return { validated: false as const, product }
  }, [replaceUnavailableProduct])

  useEffect(() => {
    const nextBanner = parseDashboardSearchMessage(window.location.search)
    if (nextBanner) setBanner(nextBanner)
  }, [])

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login')
    }
  }, [router, status])

  useEffect(() => {
    if (!compact && tab === 'more') {
      setTab('overview')
    }
  }, [compact, tab])

  const shuffleVisibleFinderResults = useCallback(() => {
    setFinderRotationTick((tick) => tick + 1)
  }, [])

  const getEbayConnectionState = useCallback((credentials: EbayCredentialsSummary | null) => {
    const hasToken = Boolean(credentials?.has_token)
    const hasRefreshToken = Boolean(credentials?.has_refresh_token)
    const tokenExpired = Boolean(credentials?.token_expired)

    return {
      connected: hasToken && (!tokenExpired || hasRefreshToken),
      needsReconnect: hasToken && tokenExpired && !hasRefreshToken,
    }
  }, [])

  const loadOrders = useCallback(async () => {
    setConnectionState((prev) => ({ ...prev, syncing: true }))

    try {
      const data = await fetchOrders()
      setConnectionState((prev) => ({
        ...prev,
        ebayConnected: !!data.connected,
        ebayNeedsReconnect: false,
      }))
      setOrderState((prev) => ({
        ...prev,
        orders: data.recent || [],
        awaiting: (data.awaiting || []).filter((order) => !isRefundedOrder(order)),
        syncTime: new Date().toLocaleTimeString(),
      }))
    } catch (error) {
      const reconnectRequired = isReconnectError(error)
      setConnectionState((prev) => ({
        ...prev,
        ebayConnected: reconnectRequired ? false : prev.ebayConnected,
        ebayNeedsReconnect: reconnectRequired || prev.ebayNeedsReconnect,
      }))
      setBanner({
        tone: 'error',
        text: reconnectRequired
          ? 'Your eBay session expired. Reconnect in Settings to resume syncing.'
          : getErrorMessage(error, 'Unable to sync eBay orders.'),
      })
    } finally {
      setConnectionState((prev) => ({ ...prev, syncing: false }))
    }
  }, [])

  const loadFinancials = useCallback(async (period?: string) => {
    setFinancialState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const data = await fetchFinancials(period ?? financialPeriod)
      setFinancialState({ loading: false, summary: data.summary, items: data.items || [], error: null })
    } catch (error) {
      setFinancialState((prev) => ({ ...prev, loading: false, error: getErrorMessage(error, 'Unable to load financial data.') }))
    }
  }, [financialPeriod])

  const loadPerformance = useCallback(async () => {
    setPerformanceState((prev) => ({ ...prev, loading: true, error: null }))

    try {
      const data = await fetchPerformance()
      setPerformanceState({
        loading: false,
        data,
        error: null,
      })
    } catch (error) {
      setPerformanceState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(error, 'Unable to load performance data.'),
      }))
    }
  }, [])

  const loadProductSourceHealth = useCallback(async () => {
    setSourceHealthState((prev) => ({ ...prev, loading: true, error: null }))

    try {
      const data = await fetchProductSourceHealth()
      setSourceHealthState({
        loading: false,
        data,
        error: null,
      })
    } catch (error) {
      setSourceHealthState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(error, 'Unable to load product source health.'),
      }))
    }
  }, [])

  const applySubscriptionStatus = useCallback((v: Awaited<ReturnType<typeof fetchSubscriptionStatus>>) => {
    setSubscriptionState({
      loading: false,
      plan: v.plan || 'trial',
      status: v.status || 'active',
      trialLimit: v.trialLimit || 5,
      listed: v.listed || 0,
      trialRemaining: v.trialRemaining ?? Math.max(0, (v.trialLimit || 5) - (v.listed || 0)),
      isPro: v.isPro ?? v.plan === 'pro',
      billingCheckoutAvailable: v.billing?.checkoutAvailable ?? false,
      billingPortalAvailable: v.billing?.portalAvailable ?? false,
      billingOwnerBypass: v.billing?.ownerBillingBypass ?? false,
    })
  }, [])

  const applyPublishedSubscription = useCallback((subscription: ListResult['subscription'] | undefined) => {
    if (!subscription) return
    setSubscriptionState((prev) => ({
      ...prev,
      loading: false,
      plan: subscription.plan || prev.plan,
      trialLimit: subscription.trialLimit || prev.trialLimit,
      listed: subscription.listed,
      trialRemaining: subscription.trialRemaining,
      isPro: (subscription.plan || prev.plan) === 'pro',
    }))
  }, [])

  const refreshSubscriptionStatus = useCallback(async () => {
    const status = await fetchSubscriptionStatus()
    applySubscriptionStatus(status)
    return status
  }, [applySubscriptionStatus])

  const loadDashboardBootstrap = useCallback(async () => {
    setSubscriptionState((prev) => ({ ...prev, loading: true }))
    const results = await Promise.allSettled([
      fetchEbayCredentials(),
      fetchUserNiche(),
      fetchOrderAsinMap(),
      fetchSubscriptionStatus(),
    ])

    const [ebayResult, nicheResult, orderMapResult, subResult] = results

    if (ebayResult.status === 'fulfilled') {
      const nextState = getEbayConnectionState(ebayResult.value.credentials)
      setConnectionState((prev) => ({
        ...prev,
        ebayConnected: nextState.connected,
        ebayNeedsReconnect: nextState.needsReconnect,
      }))
    } else {
      setBanner((prev) => prev ?? { tone: 'error', text: 'Unable to load your eBay connection status.' })
    }

    if (nicheResult.status === 'fulfilled') {
      setNicheState((prev) => ({ ...prev, value: nicheResult.value.niche }))
    } else {
      setBanner((prev) => prev ?? { tone: 'error', text: 'Unable to load your saved niche.' })
    }

    if (orderMapResult.status === 'fulfilled') {
      setOrderState((prev) => ({ ...prev, orderAsinMap: orderMapResult.value.map || {} }))
    } else {
      setBanner((prev) => prev ?? { tone: 'error', text: 'Unable to load tracked listing mappings.' })
    }

    if (subResult.status === 'fulfilled') {
      applySubscriptionStatus(subResult.value)
    } else {
      setSubscriptionState((prev) => ({ ...prev, loading: false }))
    }
  }, [applySubscriptionStatus, getEbayConnectionState])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const tabParam = params.get('tab')
    if (tabParam && TAB_QUERY_KEYS.has(tabParam as Tab)) {
      setTab(tabParam as Tab)
    }
    const billing = params.get('billing')
    if (billing === 'success') {
      setBanner({ tone: 'success', text: 'Subscription active — welcome to StackPilot Pro.' })
      void loadDashboardBootstrap()
    } else if (billing === 'canceled') {
      setBanner({ tone: 'error', text: 'Checkout canceled. You can upgrade anytime from Settings.' })
    }
    if (params.has('billing')) {
      params.delete('billing')
      const q = params.toString()
      router.replace(q ? `/dashboard?${q}` : '/dashboard', { scroll: false })
    }
  }, [router, loadDashboardBootstrap])

  const handleDisconnectEbay = useCallback(async () => {
    const confirmed = window.confirm('Disconnect eBay from this dashboard? You can reconnect it again from Settings.')
    if (!confirmed) return

    setDisconnectingEbay(true)
    try {
      await disconnectEbay()
      setConnectionState((prev) => ({
        ...prev,
        ebayConnected: false,
        ebayNeedsReconnect: false,
      }))
      setOrderState((prev) => ({
        ...prev,
        orders: [],
        awaiting: [],
        orderAsinMap: {},
      }))
      setFinancialState((prev) => ({
        ...prev,
        summary: null,
        items: [],
        error: null,
      }))
      setPerformanceState((prev) => ({
        ...prev,
        data: null,
        error: null,
      }))
      setSourceHealthState((prev) => ({
        ...prev,
        data: null,
        error: null,
      }))
      setBanner({ tone: 'success', text: 'eBay disconnected. Connect it again to refresh your token.' })
    } catch (error) {
      setBanner({ tone: 'error', text: getErrorMessage(error, 'Unable to disconnect eBay.') })
    } finally {
      setDisconnectingEbay(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'authenticated') {
      void loadDashboardBootstrap()
      void loadOrders()
      void loadFinancials()
    }
  }, [loadDashboardBootstrap, loadFinancials, loadOrders, status])

  useEffect(() => {
    if (status === 'authenticated' && tab === 'performance' && !performanceState.data && !performanceState.loading && !performanceState.error) {
      void loadPerformance()
    }
  }, [loadPerformance, performanceState.data, performanceState.error, performanceState.loading, status, tab])

  useEffect(() => {
    if (status === 'authenticated' && tab === 'settings' && !sourceHealthState.data && !sourceHealthState.loading && !sourceHealthState.error) {
      void loadProductSourceHealth()
    }
  }, [loadProductSourceHealth, sourceHealthState.data, sourceHealthState.error, sourceHealthState.loading, status, tab])

  useEffect(() => {
    if (status === 'authenticated' && tab === 'settings') {
      void refreshSubscriptionStatus().catch(() => {})
    }
  }, [refreshSubscriptionStatus, status, tab])

  const handleSaveNiche = useCallback(async (value: string) => {
    setNicheState((prev) => ({ ...prev, value, saving: true }))

    try {
      await saveUserNiche(value)
      setNicheState((prev) => ({ ...prev, saved: true }))
      setFinderState((prev) => ({ ...prev, results: null, error: null, listAllProgress: null }))
      window.setTimeout(() => {
        setNicheState((prev) => ({ ...prev, saved: false }))
      }, 2000)
    } catch (error) {
      setBanner({ tone: 'error', text: getErrorMessage(error, 'Unable to save niche.') })
    } finally {
      setNicheState((prev) => ({ ...prev, saving: false }))
    }
  }, [])

  const handleLookupAsin = useCallback(async () => {
    const raw = lookupState.input.trim().toUpperCase()
    if (!raw) return

    const isDirectAsin = /^(?=.*[A-Z])[A-Z0-9]{10}$/.test(raw)
    const isItemId = /^\d+$/.test(raw) && !isDirectAsin

    if (!isItemId && !isDirectAsin) {
      setLookupState((prev) => ({ ...prev, error: 'Enter a numeric eBay item ID or a valid 10-character Amazon ASIN.' }))
      return
    }

    setLookupState((prev) => ({ ...prev, input: raw, loading: true, error: null, result: null, rejectedAsins: [] }))

    try {
      const result = isDirectAsin ? await validateAmazonAsin(raw) : await lookupAsinByItemId(raw)
      setLookupState((prev) => ({ ...prev, result, manualAsin: result.asin }))
    } catch (error) {
      setLookupState((prev) => ({
        ...prev,
        error: isItemId && isReconnectError(error)
          ? 'Your eBay connection expired. Reconnect it in Settings.'
          : getErrorMessage(error, 'Lookup failed. Please try again.'),
      }))
    } finally {
      setLookupState((prev) => ({ ...prev, loading: false }))
    }
  }, [lookupState.input])

  const handleRejectCurrentAsin = useCallback(async () => {
    const itemId = lookupState.input.trim()
    const currentAsin = lookupState.result?.asin
    if (!itemId || !currentAsin) return
    if (!/^\d+$/.test(itemId)) {
      setLookupState((prev) => ({ ...prev, error: 'Alternate matching works with a numeric eBay item ID. Direct ASIN lookup already points to a specific Amazon product.' }))
      return
    }

    const rejectedAsins = Array.from(new Set([...lookupState.rejectedAsins, currentAsin]))
    setLookupState((prev) => ({ ...prev, loading: true, error: null, rejectedAsins }))

    try {
      const result = await lookupAsinByItemId(itemId, rejectedAsins)
      setLookupState((prev) => ({ ...prev, result, manualAsin: result.asin }))
    } catch (error) {
      setLookupState((prev) => ({
        ...prev,
        result: null,
        error: getErrorMessage(error, 'No alternate match found. Paste the correct ASIN and save it manually.'),
      }))
    } finally {
      setLookupState((prev) => ({ ...prev, loading: false }))
    }
  }, [lookupState.input, lookupState.rejectedAsins, lookupState.result?.asin])

  const handleSaveManualAsinMapping = useCallback(async (asinOverride?: string) => {
    const itemId = lookupState.input.trim()
    const asin = (asinOverride || lookupState.manualAsin).trim().toUpperCase()
    if (!/^\d+$/.test(itemId) || !/^[A-Z0-9]{10}$/.test(asin)) {
      setLookupState((prev) => ({ ...prev, error: 'Enter a numeric eBay item ID and a valid 10-character Amazon ASIN.' }))
      return
    }

    setLookupState((prev) => ({ ...prev, savingManual: true, error: null }))
    try {
      const result = await saveManualAsinMapping(itemId, asin)
      setLookupState((prev) => ({ ...prev, result, manualAsin: result.asin }))
      setOrderState((prev) => ({
        ...prev,
        orderAsinMap: {
          ...prev.orderAsinMap,
          [itemId]: {
            asin: result.asin,
            title: result.title,
            amazonUrl: result.amazonUrl,
            imageUrl: result.imageUrl,
          },
        },
      }))
      setBanner({ tone: 'success', text: `Saved ASIN ${result.asin} for eBay item #${itemId}.` })
      void loadFinancials()
    } catch (error) {
      setLookupState((prev) => ({
        ...prev,
        error: getErrorMessage(error, 'Unable to save ASIN mapping.'),
      }))
    } finally {
      setLookupState((prev) => ({ ...prev, savingManual: false }))
    }
  }, [loadFinancials, lookupState.input, lookupState.manualAsin])

  const handleConfirmCurrentAsin = useCallback(async () => {
    const currentAsin = lookupState.result?.asin
    if (!currentAsin) return
    setLookupState((prev) => ({ ...prev, manualAsin: currentAsin }))
    await handleSaveManualAsinMapping(currentAsin)
  }, [handleSaveManualAsinMapping, lookupState.result?.asin])

  const handleFindProducts = useCallback(async () => {
    if (!nicheState.value) return

    setFinderState((prev) => ({ ...prev, loading: true, error: null, results: null, listAllProgress: null }))
    setBanner((prev) => (prev?.tone === 'error' ? null : prev))

    try {
      const data = await fetchFinderProducts(nicheState.value, false, { limit: FINDER_ROTATION_POOL_TARGET })
      let products = tagFinderProducts(data.results || [], 'niche')
      if (products.length < FINDER_STOCK_TARGET) {
        const refill = await fetchFinderProducts(nicheState.value, true, {
          limit: FINDER_ROTATION_POOL_TARGET,
          excludeAsins: products.map((product) => product.asin),
        }).catch(() => null)
        if (refill?.results?.length) {
          products = mergeRefilledProducts(products, refill.results, [], 'niche')
        }
      }
      setFinderState((prev) => ({ ...prev, results: products }))
    } catch (error) {
      setFinderState((prev) => ({ ...prev, error: getErrorMessage(error, 'Product search failed.') }))
    } finally {
      setFinderState((prev) => ({ ...prev, loading: false }))
    }
  }, [nicheState.value])

  const handleFindContinuousProducts = useCallback(async () => {
    setContinuousFinderState((prev) => ({ ...prev, loading: true, error: null, results: prev.results, listAllProgress: null }))
    setBanner((prev) => (prev?.tone === 'error' ? null : prev))

    try {
      const shouldForceRefresh = Boolean(continuousFinderState.results?.length)
      const data = await fetchFinderProducts('', shouldForceRefresh, { mode: 'continuous', limit: FINDER_ROTATION_POOL_TARGET })
      setContinuousFinderState((prev) => ({ ...prev, results: tagFinderProducts(data.results || [], 'continuous') }))
    } catch (error) {
      setContinuousFinderState((prev) => ({ ...prev, results: prev.results || [], error: getErrorMessage(error, 'Continuous product search failed.') }))
    } finally {
      setContinuousFinderState((prev) => ({ ...prev, loading: false }))
    }
  }, [continuousFinderState.results])

  useEffect(() => {
    if (tab === 'continuous' && !continuousFinderState.results && !continuousFinderState.loading && !continuousFinderState.error) {
      void handleFindContinuousProducts()
    }
  }, [continuousFinderState.error, continuousFinderState.loading, continuousFinderState.results, handleFindContinuousProducts, tab])

  // Auto-reseed continuous listing when the pool drops below the display threshold.
  // This keeps it "continuous" — once the current batch is listed/removed, a fresh
  // batch is pulled automatically so the user never hits an empty queue.
  const continuousPoolSize = continuousFinderState.results?.length ?? 0
  useEffect(() => {
    if (
      tab === 'continuous' &&
      !continuousFinderState.loading &&
      !continuousFinderState.error &&
      continuousFinderState.results !== null &&
      continuousPoolSize < FINDER_STOCK_TARGET
    ) {
      // Pass the currently queued ASINs as excludes so the auto-reseed
      // fetches genuinely fresh products rather than the same ones.
      const currentQueueAsins = (continuousFinderState.results || []).map((p) => p.asin)
      console.info('[continuousAutoReseed] pool below threshold, reseeding', { poolSize: continuousPoolSize, excludeCount: currentQueueAsins.length })
      setContinuousFinderState((prev) => ({ ...prev, loading: true, error: null }))
      fetchFinderProducts('', true, {
        mode: 'continuous',
        limit: FINDER_ROTATION_POOL_TARGET,
        excludeAsins: currentQueueAsins,
      }).then((data) => {
        console.info('[continuousAutoReseed] received', { count: data.results?.length ?? 0, source: (data as { source?: string }).source })
        setContinuousFinderState((prev) => ({
          ...prev,
          loading: false,
          results: mergeRefilledProducts(prev.results, data.results || [], [], 'continuous'),
        }))
      }).catch((err: unknown) => {
        console.warn('[continuousAutoReseed] error', err)
        setContinuousFinderState((prev) => ({ ...prev, loading: false }))
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continuousPoolSize, tab])

  const publishFinderProduct = useCallback(
    async (product: FinderProduct, opts?: { trusted?: boolean; categoryId?: string }) => {
      const productNiche = product.sourceMode === 'continuous' ? product.sourceNiche || null : nicheState.value

      try {
        const data = await publishProduct({
          asin: product.asin,
          title: product.title,
          ebayPrice: product.ebayPrice,
          amazonPrice: product.amazonPrice,
          imageUrl: product.imageUrl,
          images: product.images,
          features: product.features,
          description: product.description,
          specs: product.specs,
          niche: productNiche,
          trusted: opts?.trusted,
          categoryId: opts?.categoryId,
        })

        return { asin: data.listingId ? product.asin : undefined }
      } catch (error) {
        if (isReconnectError(error)) return { reconnectRequired: true }
        const code = error instanceof DashboardApiError ? error.code : undefined
        return {
          errorCode: code || 'LISTING_FAILED',
          errorMessage: getErrorMessage(error, 'Listing failed.'),
        }
      }
    },
    [nicheState.value]
  )

  const refillNicheFinderProducts = useCallback(
    async (removeAsins: string[], fetchExcludeAsins?: string[]) => {
      if (!nicheState.value || removeAsins.length === 0) return

      const listed = new Set(removeAsins.map((asin) => asin.toUpperCase()))
      const currentResults = finderState.results || []
      const remainingAsins = currentResults
        .filter((product) => !listed.has(product.asin.toUpperCase()))
        .map((product) => product.asin)

      // fetchExcludeAsins: what to tell the API to skip (listed+skipped only, not failed).
      // Failed CHECK_FAILED products are transient — exclude them from display
      // but allow them back in the next refill so the pool stays full.
      const excludeForFetch = [...remainingAsins, ...(fetchExcludeAsins ?? removeAsins)]
      console.info('[refillNiche] fetching', { niche: nicheState.value, removeCount: removeAsins.length, remainingCount: remainingAsins.length, fetchExcludeCount: excludeForFetch.length })

      try {
        const refreshed = await fetchFinderProducts(nicheState.value, true, {
          limit: FINDER_ROTATION_POOL_TARGET,
          excludeAsins: excludeForFetch,
        })
        console.info('[refillNiche] received', { count: refreshed.results?.length ?? 0, source: (refreshed as { source?: string }).source })
        setFinderState((prev) => {
          const merged = mergeRefilledProducts(prev.results, refreshed.results || [], removeAsins, 'niche')
          console.info('[refillNiche] merged pool', { before: prev.results?.length ?? 0, after: merged?.length ?? 0 })
          return { ...prev, results: merged }
        })
      } catch {
        setFinderState((prev) => ({
          ...prev,
          results: prev.results ? prev.results.filter((product) => !listed.has(product.asin.toUpperCase())) : prev.results,
        }))
      }
    },
    [finderState.results, nicheState.value]
  )

  const refillContinuousProducts = useCallback(
    async (removeAsins: string[], fetchExcludeAsins?: string[]) => {
      if (removeAsins.length === 0) return

      const listed = new Set(removeAsins.map((asin) => asin.toUpperCase()))
      const currentResults = continuousFinderState.results || []
      const remainingAsins = currentResults
        .filter((product) => !listed.has(product.asin.toUpperCase()))
        .map((product) => product.asin)

      const excludeForFetch = [...remainingAsins, ...(fetchExcludeAsins ?? removeAsins)]
      console.info('[refillContinuous] fetching', { removeCount: removeAsins.length, remainingCount: remainingAsins.length, fetchExcludeCount: excludeForFetch.length })

      try {
        const refreshed = await fetchFinderProducts('', true, {
          mode: 'continuous',
          limit: FINDER_ROTATION_POOL_TARGET,
          excludeAsins: excludeForFetch,
        })
        console.info('[refillContinuous] received', { count: refreshed.results?.length ?? 0, source: (refreshed as { source?: string }).source })
        setContinuousFinderState((prev) => {
          const merged = mergeRefilledProducts(prev.results, refreshed.results || [], removeAsins, 'continuous')
          console.info('[refillContinuous] merged pool', { before: prev.results?.length ?? 0, after: merged?.length ?? 0 })
          return { ...prev, results: merged }
        })
      } catch {
        setContinuousFinderState((prev) => ({
          ...prev,
          results: prev.results ? prev.results.filter((product) => !listed.has(product.asin.toUpperCase())) : prev.results,
        }))
      }
    },
    [continuousFinderState.results]
  )

  const handleListAll = useCallback(async () => {
    if (!connectionState.ebayConnected) {
      setBanner({ tone: 'error', text: 'Connect eBay first in Settings.' })
      return
    }
    if (subscriptionState.loading) {
      setBanner({ tone: 'error', text: 'Checking your billing status. Try again in a moment.' })
      return
    }
    if (subscriptionState.plan === 'trial' && subscriptionState.trialRemaining <= 0) {
      setBanner({ tone: 'error', text: 'Free trial complete for this account. Upgrade in Settings to keep listing.' })
      return
    }

    const visibleProducts = visibleFinderResults || []
    let products = getPublishReadyFinderProducts(visibleProducts)
    if (subscriptionState.plan === 'trial') {
      products = products.slice(0, Math.max(0, subscriptionState.trialRemaining))
    }
    if (products.length === 0) {
      setBanner({
        tone: 'error',
        text: visibleProducts.length > 0
          ? 'These products are still being enriched. Hit Find Products again in a moment for publish-ready items.'
          : 'No publish-ready products were found for this niche yet. StackPilot is repairing the source pool in the background.',
      })
      return
    }

    const result = await listProductsInBatches({
      products,
      publish: (product) => {
        // Always use trusted mode for bulk List All. The listing route's trusted
        // path checks availability from cache and detects ASIN mismatches without
        // hitting Amazon live. Non-trusted mode scrapes Amazon for every product,
        // and 30 concurrent scrapes trigger rate-limiting → CHECK_FAILED for
        // most of the batch. Pool products already have availability validated
        // by the 30-min cron so live re-checking is redundant here.
        return publishFinderProduct(product, { trusted: true })
      },
      preflight: getBulkPreflightIssue,
      onProgress: (progress) => {
        setFinderState((prev) => ({ ...prev, listAllProgress: progress }))
      },
      concurrency: 3,
    })

    if (result.reconnectRequired) {
      setListingState((prev) => ({ ...prev, error: 'RECONNECT_REQUIRED' }))
      setConnectionState((prev) => ({ ...prev, ebayConnected: false, ebayNeedsReconnect: true }))
      setBanner({ tone: 'error', text: 'Your eBay session expired while listing. Reconnect in Settings and try again.' })
      return
    }

    // Remove all terminal ASINs from the current display.
    // For the refill FETCH: only exclude listed+skipped — not failed ones.
    // CHECK_FAILED products are not permanently invalid (rate-limit or transient
    // scrape issue) and should re-enter the next batch via the refill.
    const allTerminalAsins = [...result.listedAsins, ...result.failedAsins, ...result.skippedAsins]
    const refillExcludeAsins = [...result.listedAsins, ...result.skippedAsins]
    setFinderRotationTick((t) => t + 1)
    if (result.errors > 0) {
      await refillNicheFinderProducts(allTerminalAsins, refillExcludeAsins)
      await refreshSubscriptionStatus().catch(() => {})
      setBanner({
        tone: 'error',
        text: summarizeBulkListResult(result),
      })
      return
    }

    await refillNicheFinderProducts(allTerminalAsins, refillExcludeAsins)
    await refreshSubscriptionStatus().catch(() => {})

    setBanner({
      tone: 'success',
      text: summarizeBulkListResult(result),
    })
  }, [connectionState.ebayConnected, publishFinderProduct, refillNicheFinderProducts, refreshSubscriptionStatus, subscriptionState.loading, subscriptionState.plan, subscriptionState.trialRemaining, visibleFinderResults])

  const handleContinuousListAll = useCallback(async () => {
    if (!connectionState.ebayConnected) {
      setBanner({ tone: 'error', text: 'Connect eBay first in Settings.' })
      return
    }
    if (subscriptionState.loading) {
      setBanner({ tone: 'error', text: 'Checking your billing status. Try again in a moment.' })
      return
    }
    if (subscriptionState.plan === 'trial' && subscriptionState.trialRemaining <= 0) {
      setBanner({ tone: 'error', text: 'Free trial complete for this account. Upgrade in Settings to keep listing.' })
      return
    }

    const visibleProducts = tagFinderProducts(visibleContinuousResults || [], 'continuous')
    let products = getPublishReadyFinderProducts(visibleProducts)
    if (subscriptionState.plan === 'trial') {
      products = products.slice(0, Math.max(0, subscriptionState.trialRemaining))
    }
    if (products.length === 0) {
      setBanner({
        tone: 'error',
        text: visibleProducts.length > 0
          ? 'These products are still being enriched. Hit Find Products again in a moment for publish-ready items.'
          : 'No publish-ready continuous products are available yet. StackPilot is repairing the source pool in the background.',
      })
      return
    }

    const result = await listProductsInBatches({
      products,
      publish: (product) => publishFinderProduct(product, { trusted: true }),
      preflight: getBulkPreflightIssue,
      onProgress: (progress) => {
        setContinuousFinderState((prev) => ({ ...prev, listAllProgress: progress }))
      },
      concurrency: 2,
    })

    if (result.reconnectRequired) {
      setListingState((prev) => ({ ...prev, error: 'RECONNECT_REQUIRED' }))
      setConnectionState((prev) => ({ ...prev, ebayConnected: false, ebayNeedsReconnect: true }))
      setBanner({ tone: 'error', text: 'Your eBay session expired while listing. Reconnect in Settings and try again.' })
      return
    }

    const allTerminalAsins = [...result.listedAsins, ...result.failedAsins, ...result.skippedAsins]
    const refillExcludeAsins = [...result.listedAsins, ...result.skippedAsins]
    setFinderRotationTick((t) => t + 1)
    if (result.errors > 0) {
      await refillContinuousProducts(allTerminalAsins, refillExcludeAsins)
      await refreshSubscriptionStatus().catch(() => {})
      setBanner({
        tone: 'error',
        text: summarizeBulkListResult(result),
      })
      return
    }

    await refillContinuousProducts(allTerminalAsins, refillExcludeAsins)
    await refreshSubscriptionStatus().catch(() => {})
    setBanner({
      tone: 'success',
      text: summarizeBulkListResult(result),
    })
  }, [connectionState.ebayConnected, publishFinderProduct, refillContinuousProducts, refreshSubscriptionStatus, subscriptionState.loading, subscriptionState.plan, subscriptionState.trialRemaining, visibleContinuousResults])

  const handleRunScript = useCallback(async (file: string) => {
    setScriptRunning(file)
    setScriptMessage(null)

    try {
      const data = await runDashboardScript(file)
      setScriptMessage({ file, tone: 'info', text: data.message || 'Completed.' })
    } catch (error) {
      setScriptMessage({ file, tone: 'error', text: getErrorMessage(error, 'Failed to run script.') })
    } finally {
      setScriptRunning(null)
    }
  }, [])

  const openListModal = useCallback((product: FinderProduct) => {
    setListingState({
      modal: product,
      price: product.ebayPrice.toFixed(2),
      validating: true,
      validated: false,
      loading: false,
      result: null,
      error: null,
    })
    void validateListingProduct(product)
  }, [validateListingProduct])

  const closeListModal = useCallback(() => {
    setListingState((prev) => ({
      ...prev,
      modal: null,
      validating: false,
      validated: false,
      result: null,
      error: null,
    }))
  }, [])

  const handlePublishCurrentProduct = useCallback(async () => {
    if (!listingState.modal) return
    if (subscriptionState.loading) {
      setListingState((prev) => ({ ...prev, error: 'Checking your billing status. Try again in a moment.' }))
      return
    }
    if (subscriptionState.plan === 'trial' && subscriptionState.trialRemaining <= 0) {
      setListingState((prev) => ({ ...prev, error: 'Free trial complete for this account. Upgrade in Settings to keep publishing.' }))
      return
    }

    let productToPublish = listingState.modal
    let priceValue = listingState.price

    if (!listingState.validated) {
      const validationResult = await validateListingProduct(listingState.modal)
      if (!validationResult.validated) {
        setListingState((prev) => ({
          ...prev,
          error: 'unavailable' in validationResult && validationResult.unavailable
            ? 'This Amazon source is currently unavailable, so StackPilot removed it from the queue and is pulling a replacement.'
            : 'Amazon validation did not finish cleanly. Validation was retried once but still did not confirm a live Amazon title, image, and cost.',
        }))
        return
      }
      productToPublish = validationResult.product
      if (priceValue === listingState.modal.ebayPrice.toFixed(2)) {
        priceValue = validationResult.product.ebayPrice.toFixed(2)
      }
    }

    const parsedPrice = parseFloat(priceValue)
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setListingState((prev) => ({ ...prev, error: 'Enter a valid eBay price before publishing.' }))
      return
    }

    setListingState((prev) => ({ ...prev, loading: true, error: null }))
    const sourceMode = productToPublish.sourceMode === 'continuous' ? 'continuous' : 'niche'
    const productNiche = sourceMode === 'continuous' ? productToPublish.sourceNiche || null : nicheState.value

    try {
      const data = await publishProduct({
        asin: productToPublish.asin,
        title: productToPublish.title,
        ebayPrice: parsedPrice,
        amazonPrice: productToPublish.amazonPrice,
        imageUrl: productToPublish.imageUrl,
        images: productToPublish.images,
        features: productToPublish.features,
        description: productToPublish.description,
        specs: productToPublish.specs,
        niche: productNiche,
      })

      setListingState((prev) => ({ ...prev, result: data }))
      applyPublishedSubscription(data.subscription)
      if (sourceMode === 'continuous') {
        await refillContinuousProducts([productToPublish.asin])
      } else {
        await refillNicheFinderProducts([productToPublish.asin])
      }
      setBanner({ tone: 'success', text: `Listing ${data.listingId} is now live on eBay.` })
      // Refresh trial counter after publishing.
      await refreshSubscriptionStatus().catch(() => {})
    } catch (error) {
      const errorCode = error instanceof DashboardApiError ? error.code : undefined
      const message = getErrorMessage(error, 'Something went wrong. Please try again.')
      const unavailableSource = errorCode === 'PRODUCT_UNAVAILABLE' || /currently unavailable on Amazon|Amazon source/i.test(message)

      if (unavailableSource) {
        const friendly = 'This Amazon source is currently unavailable, so StackPilot removed it from the queue and is pulling a replacement.'
        setListingState((prev) => ({
          ...prev,
          validated: false,
          error: friendly,
        }))
        if (sourceMode === 'continuous') {
          await refillContinuousProducts([productToPublish.asin])
        } else {
          await refillNicheFinderProducts([productToPublish.asin])
        }
        setBanner({ tone: 'error', text: friendly })
        return
      }

      setListingState((prev) => ({
        ...prev,
        error: isReconnectError(error) ? 'RECONNECT_REQUIRED' : message,
      }))
      if (isReconnectError(error)) {
        setConnectionState((prev) => ({ ...prev, ebayConnected: false, ebayNeedsReconnect: true }))
      }
    } finally {
      setListingState((prev) => ({ ...prev, loading: false }))
    }
  }, [applyPublishedSubscription, listingState.modal, listingState.price, listingState.validated, nicheState.value, refillContinuousProducts, refillNicheFinderProducts, refreshSubscriptionStatus, subscriptionState.loading, subscriptionState.plan, subscriptionState.trialRemaining, validateListingProduct])

  const grossRevenue = useMemo(() => getGrossRevenue(orderState.orders), [orderState.orders])

  if (status === 'loading' || status === 'unauthenticated') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
        <div style={{ color: 'var(--dim)', fontSize: '13px', letterSpacing: '0.1em' }}>Loading...</div>
      </div>
    )
  }

  return (
    <div className={compact ? 'dashboard-shell dashboard-shell--compact' : 'dashboard-shell'}>
      <DashboardSidebar
        tab={tab}
        onTabChange={setTab}
        connected={connectionState.ebayConnected}
        niche={nicheState.value}
        awaitingCount={orderState.awaiting.length}
        userLabel={session?.user?.name || session?.user?.email}
        subscriptionPlan={subscriptionState.loading ? null : subscriptionState.plan}
        onSignOut={() => signOut({ callbackUrl: '/' })}
        mobileOpen={mobileNavOpen}
        onRequestClose={() => setMobileNavOpen(false)}
        hidden={compact}
      />

      <main className="dashboard-main">
        <DashboardBanner banner={banner} onClose={() => setBanner(null)} />
        {compact ? <GetTheAppBanner compact /> : null}
        {compact ? (
          <>
            <CompactPwaTopbar
              connected={connectionState.ebayConnected}
              onMenuClick={() => setPwaMenuOpen(true)}
              onStatusClick={() => setTab('settings')}
            />
            <CompactPwaMenu
              open={pwaMenuOpen}
              onClose={() => setPwaMenuOpen(false)}
              onSync={() => {
                void loadOrders()
                void loadFinancials()
                if (tab === 'performance') void loadPerformance()
                if (tab === 'settings') void loadProductSourceHealth()
              }}
              syncing={connectionState.syncing}
              syncTime={orderState.syncTime}
              onFulfillment={() => setTab('fulfillment')}
              onSettings={() => setTab('settings')}
              userLabel={session?.user?.name || session?.user?.email}
              subscriptionPlan={subscriptionState.loading ? null : subscriptionState.plan}
              onSignOut={() => signOut({ callbackUrl: '/' })}
            />
          </>
        ) : (
          <DashboardTopbar
            tab={tab}
            syncTime={orderState.syncTime}
            syncing={connectionState.syncing}
            onSync={() => {
              void loadOrders()
              void loadFinancials()
              if (tab === 'performance') void loadPerformance()
              if (tab === 'settings') void loadProductSourceHealth()
            }}
            onToggleNav={() => setMobileNavOpen((prev) => !prev)}
            compact={false}
            trial={{
              loading: subscriptionState.loading,
              plan: subscriptionState.plan,
              listed: subscriptionState.listed,
              trialLimit: subscriptionState.trialLimit,
              trialRemaining: subscriptionState.trialRemaining,
            }}
          />
        )}

        <div className="dashboard-content">
          {tab === 'overview' ? (
            compact ? (
              <CompactHomeTab
                connected={connectionState.ebayConnected}
                awaitingCount={orderState.awaiting.length}
                orders={orderState.orders}
                userName={session?.user?.name || session?.user?.email || null}
                onOpenSettings={() => setTab('settings')}
                onGo={setTab}
                trial={{
                  loading: subscriptionState.loading,
                  plan: subscriptionState.plan,
                  listed: subscriptionState.listed,
                  trialLimit: subscriptionState.trialLimit,
                  trialRemaining: subscriptionState.trialRemaining,
                }}
              />
            ) : (
              <OverviewTab
                connected={connectionState.ebayConnected}
                orders={orderState.orders}
                awaitingCount={orderState.awaiting.length}
                grossRevenue={grossRevenue}
                userName={session?.user?.name || session?.user?.email || null}
                onOpenSettings={() => setTab('settings')}
                trial={{
                  loading: subscriptionState.loading,
                  plan: subscriptionState.plan,
                  listed: subscriptionState.listed,
                  trialLimit: subscriptionState.trialLimit,
                  trialRemaining: subscriptionState.trialRemaining,
                }}
              />
            )
          ) : null}
          {tab === 'more' ? (
            <CompactMoreTab onOpenTab={setTab} onSignOut={() => signOut({ callbackUrl: '/' })} />
          ) : null}
          {tab === 'orders' ? (
            <OrdersTab
              connected={connectionState.ebayConnected}
              orders={orderState.orders}
              awaiting={orderState.awaiting}
              grossRevenue={grossRevenue}
              onOpenSettings={() => setTab('settings')}
              compact={compact}
            />
          ) : null}
          {tab === 'fulfillment' ? (
            <FulfillmentTab
              connected={connectionState.ebayConnected}
              awaiting={orderState.awaiting}
              orderAsinMap={orderState.orderAsinMap}
              onOpenSettings={() => setTab('settings')}
              compact={compact}
            />
          ) : null}
          {tab === 'financials' ? (
            <FinancialsTab
              connected={connectionState.ebayConnected}
              loading={financialState.loading}
              error={financialState.error}
              summary={financialState.summary}
              items={financialState.items}
              period={financialPeriod}
              onPeriodChange={(p) => { setFinancialPeriod(p); void loadFinancials(p) }}
              onRefresh={() => void loadFinancials()}
              onOpenSettings={() => setTab('settings')}
              compact={compact}
            />
          ) : null}
          {tab === 'performance' ? (
            <PerformanceTab
              connected={connectionState.ebayConnected}
              loading={performanceState.loading}
              error={performanceState.error}
              data={performanceState.data}
              onRefresh={() => void loadPerformance()}
              onOpenSettings={() => setTab('settings')}
              onOpenProductFinder={() => setTab('product')}
              compact={compact}
            />
          ) : null}
          {tab === 'scripts' ? (
            compact ? (
              <CompactDesktopHint
                title="Scripts"
                body="Automation and bulk actions are built for a large screen. Open StackPilot in a desktop browser when you need to run scripts."
              />
            ) : (
              <ScriptsTab scriptRunning={scriptRunning} scriptMessage={scriptMessage} onRunScript={(file) => handleRunScript(file)} onOpenProductFinder={() => setTab('product')} />
            )
          ) : null}
          {tab === 'asin' ? (
            <AsinLookupTab
              asinInput={lookupState.input}
              onAsinInputChange={(value) => setLookupState((prev) => ({ ...prev, input: value }))}
              onLookup={() => void handleLookupAsin()}
              asinLoading={lookupState.loading}
              asinError={lookupState.error}
              asinResult={lookupState.result}
              manualAsin={lookupState.manualAsin}
              onManualAsinChange={(value) => setLookupState((prev) => ({ ...prev, manualAsin: value }))}
              onSaveManualMapping={() => void handleSaveManualAsinMapping()}
              onConfirmCurrent={() => void handleConfirmCurrentAsin()}
              onRejectCurrent={() => void handleRejectCurrentAsin()}
              manualSaving={lookupState.savingManual}
              orders={orderState.orders}
              orderAsinMap={orderState.orderAsinMap}
              onReset={() => setLookupState({ input: '', manualAsin: '', rejectedAsins: [], result: null, loading: false, savingManual: false, error: null })}
            />
          ) : null}
          {tab === 'product' ? (
            <ProductListingTab
              niche={nicheState.value}
              nicheSaving={nicheState.saving}
              onSelectNiche={(value) => void handleSaveNiche(value)}
              onClearNiche={() => {
                setNicheState((prev) => ({ ...prev, value: null }))
                setFinderState({ loading: false, results: null, error: null, view: 'cards', listAllProgress: null })
              }}
              finderLoading={finderState.loading}
              finderResults={visibleFinderResults}
              finderError={finderState.error}
              finderView={finderState.view}
              onFinderViewChange={(view) => setFinderState((prev) => ({ ...prev, view }))}
              onFindProducts={() => void handleFindProducts()}
              onShuffleResults={shuffleVisibleFinderResults}
              onOpenAsinLookup={() => setTab('asin')}
              onOpenScripts={() => setTab('scripts')}
              onOpenListModal={(product) => openListModal({ ...product, sourceMode: 'niche' })}
              onListAll={() => void handleListAll()}
              listAllProgress={finderState.listAllProgress}
              connected={connectionState.ebayConnected}
              compact={compact}
              trial={{
                loading: subscriptionState.loading,
                plan: subscriptionState.plan,
                listed: subscriptionState.listed,
                trialLimit: subscriptionState.trialLimit,
                trialRemaining: subscriptionState.trialRemaining,
              }}
            />
          ) : null}
          {tab === 'continuous' ? (
            <ContinuousListingTab
              finderLoading={continuousFinderState.loading}
              finderResults={visibleContinuousResults}
              finderError={continuousFinderState.error}
              finderView={continuousFinderState.view}
              onFinderViewChange={(view) => setContinuousFinderState((prev) => ({ ...prev, view }))}
              onFindProducts={() => void handleFindContinuousProducts()}
              onOpenListModal={(product) => openListModal({ ...product, sourceMode: 'continuous' })}
              onListAll={() => void handleContinuousListAll()}
              listAllProgress={continuousFinderState.listAllProgress}
              connected={connectionState.ebayConnected}
              compact={compact}
              trial={{
                loading: subscriptionState.loading,
                plan: subscriptionState.plan,
                listed: subscriptionState.listed,
                trialLimit: subscriptionState.trialLimit,
                trialRemaining: subscriptionState.trialRemaining,
              }}
            />
          ) : null}
          {tab === 'campaigns' ? (
            compact ? (
              <CompactDesktopHint
                title="Campaigns"
                body="Creating and tuning promoted listings is easier on a wide layout. Use Seller Hub on desktop for deep campaign work, or open the full StackPilot dashboard in a browser."
              />
            ) : (
              <CampaignsTab connected={connectionState.ebayConnected} />
            )
          ) : null}
          {tab === 'settings' ? (
            <SettingsTab
              connected={connectionState.ebayConnected}
              needsReconnect={connectionState.ebayNeedsReconnect}
              niche={nicheState.value}
              nicheSaved={nicheState.saved}
              onSync={() => {
                void loadOrders()
                void loadFinancials()
                void loadPerformance()
                void loadProductSourceHealth()
              }}
              onDisconnectEbay={() => void handleDisconnectEbay()}
              disconnectingEbay={disconnectingEbay}
              onOpenProductTab={() => setTab('product')}
              sourceHealth={sourceHealthState.data}
              sourceHealthLoading={sourceHealthState.loading}
              sourceHealthError={sourceHealthState.error}
              onRefreshSourceHealth={() => void loadProductSourceHealth()}
              compact={compact}
              subscriptionPlan={subscriptionState.plan}
              subscriptionStatus={subscriptionState.status}
              trialListed={subscriptionState.listed}
              trialLimit={subscriptionState.trialLimit}
              trialRemaining={subscriptionState.trialRemaining}
              billingCheckoutAvailable={subscriptionState.billingCheckoutAvailable}
              billingPortalAvailable={subscriptionState.billingPortalAvailable}
              billingOwnerBypass={subscriptionState.billingOwnerBypass}
            />
          ) : null}
        </div>
      </main>

      {compact ? (
        <CompactBottomNav tab={tab} onTabChange={setTab} awaitingCount={orderState.awaiting.length} />
      ) : null}

      <SellOnEbayModal
        product={listingState.modal}
        listPrice={listingState.price}
        onListPriceChange={(value) => setListingState((prev) => ({ ...prev, price: value }))}
        validating={listingState.validating}
        validated={listingState.validated}
        listLoading={listingState.loading}
        listResult={listingState.result}
        listError={listingState.error}
        trialLocked={!subscriptionState.loading && subscriptionState.plan === 'trial' && subscriptionState.trialRemaining <= 0}
        onClose={closeListModal}
        onPublish={() => handlePublishCurrentProduct()}
      />
    </div>
  )
}
