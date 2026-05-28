// Phase 4 — Scalable graph discovery + ASIN universe persistence.
//
// Implements the "separate massive cheap discovery from selective enrichment" architecture:
//
//   mass discovery (FREE)  →  lightweight filter  →  dedupe  →  priority score
//        →  quota-gated enrichment  →  validation/preflight  →  list-ready
//
// This module owns the DISCOVERY half — recursively expanding the ASIN universe cheaply via
// keyword / brand / category-adjacency scraping, with per-branch confidence decay so weak
// branches terminate early and strong branches expand deeper. Discovered candidates land in
// product_source_items at enrichment_status='raw' (search-level data only). The staged-enrichment
// module promotes the strongest raw candidates to full enrichment under a quota budget.
//
// Nothing here calls a paid API — discovery is intentionally free + high-volume. The graph is
// persisted in product_discovery_edges so the ASIN universe is a permanent, reactivatable asset.

import { queryRows, sql } from '@/lib/db'
import { scrapeAmazonSearch } from '@/lib/amazon-scrape'
import { getMeaningfulTitleWords, isWeakListingTitle } from '@/lib/listing-quality'
import { EBAY_DEFAULT_FEE_RATE, getListingMetrics, getRecommendedEbayPrice } from '@/lib/listing-pricing'
import { upsertProductSourceItems } from '@/lib/product-source-engine'

const MIN_PROFIT = 6
const MAX_COST = 300

// Overload protection: hard ceiling on Amazon search scrapes per discovery run, independent of
// node/branch budgets. Prevents a large node_budget from hammering Amazon. A small delay between
// nodes further spreads the load so we don't trip bot detection.
const MAX_SCRAPES_PER_RUN = 120
const INTER_NODE_DELAY_MS = 350

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v || 0)
  return Number.isFinite(n) ? n : 0
}
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)) }

function calcMetrics(amazonPrice: number) {
  const ebayPrice = getRecommendedEbayPrice(amazonPrice, EBAY_DEFAULT_FEE_RATE)
  const { profit, roi } = getListingMetrics(amazonPrice, ebayPrice, EBAY_DEFAULT_FEE_RATE)
  return { ebayPrice, profit, roi }
}

// ────────────────────────────── Schema ──────────────────────────────

export async function ensureDiscoveryColumns() {
  // Discovery-graph metadata on the universe. enrichment_status is the staged-enrichment state:
  //   raw       → discovered, only search-level data (title/price/image)
  //   enriched  → full product detail pulled (images/specs/description)
  //   validated → passed full preflight (set at list time)
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS discovery_source TEXT`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS discovery_depth INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS parent_asin TEXT`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS discovery_confidence NUMERIC(6,3)`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'raw'`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS evergreen BOOLEAN NOT NULL DEFAULT TRUE`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS revalidation_count INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS dormant_at TIMESTAMPTZ`.catch(() => {})
  await sql`ALTER TABLE product_source_items ADD COLUMN IF NOT EXISTS enrichment_attempts INTEGER NOT NULL DEFAULT 0`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_enrichment_idx ON product_source_items (enrichment_status, total_score DESC)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS product_source_items_discovery_depth_idx ON product_source_items (discovery_depth, discovery_source)`.catch(() => {})

  // Backfill: pre-Phase-4 products that already have a cache row with 2+ images are 'enriched'
  // (so they're not mislabeled 'raw' in metrics and aren't excluded from list-ready). Idempotent —
  // only touches rows still marked 'raw'. The list-ready gate uses the cache join (not this field),
  // so this is purely for accurate visibility/conversion metrics.
  await sql`
    UPDATE product_source_items psi
    SET enrichment_status = 'enriched'
    FROM amazon_product_cache apc
    WHERE UPPER(apc.asin) = UPPER(psi.asin)
      AND psi.enrichment_status = 'raw'
      AND jsonb_typeof(apc.images) = 'array'
      AND jsonb_array_length(apc.images) >= 2
  `.catch(() => {})
  // Products with a live eBay listing are 'validated' (passed full preflight at list time).
  await sql`
    UPDATE product_source_items psi
    SET enrichment_status = 'validated'
    WHERE psi.enrichment_status IN ('raw', 'enriched')
      AND EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin))
  `.catch(() => {})

  await sql`
    CREATE TABLE IF NOT EXISTS product_discovery_edges (
      parent_asin TEXT NOT NULL,
      child_asin TEXT NOT NULL,
      edge_type TEXT NOT NULL DEFAULT 'keyword_adjacency',
      depth INTEGER NOT NULL DEFAULT 1,
      confidence NUMERIC(6,3),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (parent_asin, child_asin)
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS discovery_edges_child_idx ON product_discovery_edges (child_asin)`.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS discovery_edges_created_idx ON product_discovery_edges (created_at DESC)`.catch(() => {})

  await sql`
    CREATE TABLE IF NOT EXISTS discovery_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      max_depth INTEGER NOT NULL DEFAULT 2,
      branch_budget INTEGER NOT NULL DEFAULT 8,
      node_budget INTEGER NOT NULL DEFAULT 40,
      enrichment_budget INTEGER NOT NULL DEFAULT 20,
      confidence_floor NUMERIC(6,3) NOT NULL DEFAULT 0.18,
      evergreen_aggressiveness NUMERIC(6,3) NOT NULL DEFAULT 1.0,
      reactivation_batch INTEGER NOT NULL DEFAULT 30,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(() => {})
  await sql`INSERT INTO discovery_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`.catch(() => {})
}

export type DiscoverySettings = {
  enabled: boolean
  maxDepth: number
  branchBudget: number
  nodeBudget: number
  enrichmentBudget: number
  confidenceFloor: number
  evergreenAggressiveness: number
  reactivationBatch: number
}

// Conservative defaults — depth 2 max, capped enrichment, decay on. Combined RapidAPI usage
// (enrichment 15 + reactivation 10 = 25/run × 8 runs/day = 200/day) stays under the 333/day
// RapidAPI ceiling, and the quota gate hard-stops both well before that.
const DEFAULT_SETTINGS: DiscoverySettings = {
  enabled: true,
  maxDepth: 2,
  branchBudget: 8,
  nodeBudget: 40,
  enrichmentBudget: 15,
  confidenceFloor: 0.18,
  evergreenAggressiveness: 1.0,
  reactivationBatch: 10,
}

export async function getDiscoverySettings(): Promise<DiscoverySettings> {
  await ensureDiscoveryColumns()
  const rows = await queryRows<{
    enabled: boolean; max_depth: number; branch_budget: number; node_budget: number
    enrichment_budget: number; confidence_floor: string | number; evergreen_aggressiveness: string | number
    reactivation_batch: number
  }>`SELECT * FROM discovery_settings WHERE id = 1`.catch(() => [])
  const r = rows[0]
  if (!r) return DEFAULT_SETTINGS
  return {
    enabled: !!r.enabled,
    maxDepth: toNum(r.max_depth) || DEFAULT_SETTINGS.maxDepth,
    branchBudget: toNum(r.branch_budget) || DEFAULT_SETTINGS.branchBudget,
    nodeBudget: toNum(r.node_budget) || DEFAULT_SETTINGS.nodeBudget,
    enrichmentBudget: toNum(r.enrichment_budget) ?? DEFAULT_SETTINGS.enrichmentBudget,
    confidenceFloor: toNum(r.confidence_floor) || DEFAULT_SETTINGS.confidenceFloor,
    evergreenAggressiveness: toNum(r.evergreen_aggressiveness) || DEFAULT_SETTINGS.evergreenAggressiveness,
    reactivationBatch: toNum(r.reactivation_batch) || DEFAULT_SETTINGS.reactivationBatch,
  }
}

export async function updateDiscoverySettings(patch: Partial<DiscoverySettings>): Promise<DiscoverySettings> {
  await ensureDiscoveryColumns()
  const current = await getDiscoverySettings()
  const next = { ...current, ...patch }
  // Clamp to sane bounds so the UI can't set runaway values.
  next.maxDepth = clamp(Math.round(next.maxDepth), 1, 4)
  next.branchBudget = clamp(Math.round(next.branchBudget), 2, 25)
  next.nodeBudget = clamp(Math.round(next.nodeBudget), 5, 150)
  next.enrichmentBudget = clamp(Math.round(next.enrichmentBudget), 0, 100)
  next.confidenceFloor = clamp(next.confidenceFloor, 0.05, 0.6)
  next.evergreenAggressiveness = clamp(next.evergreenAggressiveness, 0.5, 2.0)
  next.reactivationBatch = clamp(Math.round(next.reactivationBatch), 0, 200)
  await sql`
    UPDATE discovery_settings SET
      enabled = ${next.enabled},
      max_depth = ${next.maxDepth},
      branch_budget = ${next.branchBudget},
      node_budget = ${next.nodeBudget},
      enrichment_budget = ${next.enrichmentBudget},
      confidence_floor = ${next.confidenceFloor},
      evergreen_aggressiveness = ${next.evergreenAggressiveness},
      reactivation_batch = ${next.reactivationBatch},
      updated_at = NOW()
    WHERE id = 1
  `.catch(() => {})
  return next
}

// ────────────────────────────── Free edge generation ──────────────────────────────
//
// Given a parent node, generate adjacent search queries from its meaningful title words,
// brand, and niche, then scrape them. This is the FREE graph-traversal engine: products that
// share keyword/brand/category space are the "related items / also-bought / similar" neighbors.

type GraphNode = {
  asin: string
  title: string
  niche: string | null
  depth: number
  confidence: number
  evergreen: boolean
}

type RawCandidate = {
  asin: string
  title: string
  amazonPrice: number
  ebayPrice: number
  profit: number
  roi: number
  imageUrl: string
  risk: string
  rating: number
  reviewCount: number
  sourceNiche: string | null
  parentAsin: string
  depth: number
  confidence: number
  evergreen: boolean
  edgeType: string
}

function buildAdjacencyQueries(node: GraphNode): Array<{ query: string; edgeType: string }> {
  const words = Array.from(new Set(getMeaningfulTitleWords(node.title))).slice(0, 6)
  if (words.length < 2) return []
  const queries: Array<{ query: string; edgeType: string }> = []

  // Category adjacency — pairs of core product words (the product's "neighborhood")
  queries.push({ query: words.slice(0, 3).join(' '), edgeType: 'category_adjacency' })
  if (words.length >= 4) queries.push({ query: words.slice(1, 4).join(' '), edgeType: 'similar_items' })

  // Brand ecosystem — first word is often a brand; pair with the category noun
  const brandLike = words[0]
  if (brandLike && brandLike.length >= 3 && words[1]) {
    queries.push({ query: `${brandLike} ${words[1]}`, edgeType: 'brand_ecosystem' })
  }

  // Niche-anchored keyword expansion — keeps drift inside the product family
  if (node.niche) {
    queries.push({ query: `${words[0]} ${node.niche.split(' ').slice(0, 2).join(' ')}`, edgeType: 'keyword_expansion' })
  }

  // Dedupe queries
  const seen = new Set<string>()
  return queries.filter((q) => {
    const key = q.query.toLowerCase().trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Quality signal (0-1) for a freshly discovered candidate, used in confidence decay. */
function candidateQualitySignal(c: { profit: number; roi: number; reviewCount: number; rating: number }): number {
  const marginScore = clamp(c.profit / 18, 0, 1)
  const roiScore = clamp(c.roi / 60, 0, 1)
  const demandScore = clamp(Math.log10((c.reviewCount || 0) + 10) / 4, 0, 1)
  const ratingScore = clamp((c.rating || 3) / 5, 0, 1)
  return clamp(0.25 * marginScore + 0.25 * roiScore + 0.3 * demandScore + 0.2 * ratingScore, 0, 1)
}

// Depth decay — each hop away from a proven seed loses confidence.
function depthDecay(depth: number): number {
  return [1.0, 0.62, 0.40, 0.26][Math.min(depth, 3)]
}

async function generateRelatedCandidates(
  node: GraphNode,
  branchBudget: number,
  scrapeBudget: { used: number; max: number },
): Promise<RawCandidate[]> {
  const queries = buildAdjacencyQueries(node)
  if (queries.length === 0) return []

  const out = new Map<string, RawCandidate>()
  for (const { query, edgeType } of queries) {
    if (out.size >= branchBudget) break
    if (scrapeBudget.used >= scrapeBudget.max) break // global scrape ceiling
    scrapeBudget.used++
    const results = await scrapeAmazonSearch(query, 1, 7000).catch(() => [])
    for (const p of results) {
      if (out.size >= branchBudget) break
      const asin = String(p.asin || '')
      if (!asin || asin === node.asin || out.has(asin)) continue
      const price = toNum(p.price)
      const title = String(p.title || '')
      if (!price || price <= 0 || price > MAX_COST || !title || isWeakListingTitle(title)) continue
      const { ebayPrice, profit, roi } = calcMetrics(price)
      if (profit < MIN_PROFIT) continue
      const risk = price > 150 ? 'HIGH' : price > 60 || roi < 45 ? 'MEDIUM' : 'LOW'
      const quality = candidateQualitySignal({ profit, roi, reviewCount: p.reviewCount || 0, rating: p.rating || 0 })
      const confidence = Number((node.confidence * depthDecay(node.depth) * (0.5 + 0.5 * quality)).toFixed(3))
      out.set(asin, {
        asin, title, amazonPrice: price, ebayPrice, profit, roi,
        imageUrl: p.imageUrl || '', risk, rating: p.rating || 0, reviewCount: p.reviewCount || 0,
        sourceNiche: node.niche, parentAsin: node.asin, depth: node.depth + 1, confidence,
        evergreen: node.evergreen, edgeType,
      })
    }
  }
  return Array.from(out.values())
}

// ────────────────────────────── Recursion controller (BFS) ──────────────────────────────

export type DiscoveryRunResult = {
  durationMs: number
  seedsProcessed: number
  nodesExpanded: number
  candidatesDiscovered: number
  candidatesWritten: number
  edgesWritten: number
  weakBranchesTerminated: number
  scrapesUsed: number
  scrapeCeiling: number
  byDepth: Record<number, number>
  skipped?: string
}

/**
 * Loads seed nodes: top-performing + evergreen ASINs that are proven worth expanding from.
 * Prefers products that already sold or have high inventory quality.
 */
async function loadSeeds(limit: number): Promise<GraphNode[]> {
  const rows = await queryRows<{ asin: string; title: string; source_niche: string | null; evergreen: boolean | null }>`
    SELECT psi.asin, psi.title, psi.source_niche, psi.evergreen
    FROM product_source_items psi
    WHERE psi.active = TRUE
      AND psi.title IS NOT NULL
      AND (psi.source_quality = 'ready' OR psi.intelligence_score IS NOT NULL)
    ORDER BY
      COALESCE(psi.inventory_quality_score, 0) DESC,
      COALESCE(psi.intelligence_score, psi.total_score) DESC
    LIMIT ${limit}
  `.catch(() => [])
  return rows.map((r) => ({
    asin: r.asin,
    title: r.title,
    niche: r.source_niche,
    depth: 0,
    confidence: 1.0,
    evergreen: r.evergreen !== false,
  }))
}

/** Returns the set of ASINs already in the universe so we dedupe instead of rediscovering. */
async function loadKnownAsins(): Promise<Set<string>> {
  const rows = await queryRows<{ asin: string }>`SELECT asin FROM product_source_items`.catch(() => [])
  return new Set(rows.map((r) => String(r.asin).toUpperCase()))
}

export async function runGraphDiscovery(opts: { maxRuntimeMs?: number } = {}): Promise<DiscoveryRunResult> {
  await ensureDiscoveryColumns()
  const settings = await getDiscoverySettings()
  const startedAt = Date.now()
  const maxRuntime = opts.maxRuntimeMs ?? 240_000

  const result: DiscoveryRunResult = {
    durationMs: 0, seedsProcessed: 0, nodesExpanded: 0, candidatesDiscovered: 0,
    candidatesWritten: 0, edgesWritten: 0, weakBranchesTerminated: 0,
    scrapesUsed: 0, scrapeCeiling: MAX_SCRAPES_PER_RUN, byDepth: {},
  }

  if (!settings.enabled) { result.skipped = 'disabled'; result.durationMs = Date.now() - startedAt; return result }

  const known = await loadKnownAsins()
  const seeds = await loadSeeds(Math.max(5, Math.ceil(settings.nodeBudget / 3)))
  if (seeds.length === 0) { result.skipped = 'no_seeds'; result.durationMs = Date.now() - startedAt; return result }

  const queue: GraphNode[] = [...seeds]
  const newCandidates: RawCandidate[] = []
  const scrapeBudget = { used: 0, max: MAX_SCRAPES_PER_RUN }

  while (queue.length > 0 && result.nodesExpanded < settings.nodeBudget) {
    if (Date.now() - startedAt > maxRuntime) break
    if (scrapeBudget.used >= scrapeBudget.max) break // global scrape ceiling reached
    const node = queue.shift()!
    if (node.depth >= settings.maxDepth) continue
    if (node.depth === 0) result.seedsProcessed++

    // Adaptive branch budget: evergreen branches get a bit more room; high-confidence too.
    const adaptiveBudget = Math.round(
      settings.branchBudget * (node.evergreen ? settings.evergreenAggressiveness : 0.85) * clamp(0.6 + node.confidence, 0.6, 1.4)
    )

    const candidates = await generateRelatedCandidates(node, Math.max(2, adaptiveBudget), scrapeBudget)
    result.nodesExpanded++
    // Spread scrape load to avoid tripping Amazon bot detection.
    if (queue.length > 0 && scrapeBudget.used < scrapeBudget.max) {
      await new Promise((r) => setTimeout(r, INTER_NODE_DELAY_MS))
    }
    result.candidatesDiscovered += candidates.length

    for (const c of candidates) {
      // Weak-branch termination
      if (c.confidence < settings.confidenceFloor) { result.weakBranchesTerminated++; continue }
      const upper = c.asin.toUpperCase()
      if (known.has(upper)) continue // dedupe vs existing universe
      known.add(upper)
      newCandidates.push(c)
      result.byDepth[c.depth] = (result.byDepth[c.depth] || 0) + 1

      // Strong branches continue expanding
      if (c.depth < settings.maxDepth && c.confidence >= settings.confidenceFloor * 1.5) {
        queue.push({
          asin: c.asin, title: c.title, niche: c.sourceNiche, depth: c.depth,
          confidence: c.confidence, evergreen: c.evergreen,
        })
      }
    }
  }

  // Persist: write raw candidates through the proven economic pipeline, then tag discovery metadata.
  if (newCandidates.length > 0) {
    const written = await upsertProductSourceItems(
      newCandidates.map((c) => ({
        asin: c.asin, title: c.title, amazonPrice: c.amazonPrice, ebayPrice: c.ebayPrice,
        profit: c.profit, roi: c.roi, imageUrl: c.imageUrl, risk: c.risk, salesVolume: '',
        sourceNiche: c.sourceNiche || undefined, _rating: c.rating, _numRatings: c.reviewCount,
        sourceProvider: 'graph-discovery',
      })),
    ).catch(() => 0)
    result.candidatesWritten = written

    // Tag discovery metadata + write edges (batched).
    for (const c of newCandidates) {
      await sql`
        UPDATE product_source_items
        SET discovery_source = ${c.edgeType},
            discovery_depth = ${c.depth},
            parent_asin = ${c.parentAsin},
            discovery_confidence = ${c.confidence},
            enrichment_status = CASE WHEN enrichment_status = 'enriched' OR enrichment_status = 'validated' THEN enrichment_status ELSE 'raw' END,
            evergreen = ${c.evergreen}
        WHERE asin = ${c.asin}
      `.catch(() => {})
      const edge = await sql`
        INSERT INTO product_discovery_edges (parent_asin, child_asin, edge_type, depth, confidence)
        VALUES (${c.parentAsin}, ${c.asin}, ${c.edgeType}, ${c.depth}, ${c.confidence})
        ON CONFLICT (parent_asin, child_asin) DO NOTHING
      `.catch(() => null)
      if (edge) result.edgesWritten++
    }
  }

  result.scrapesUsed = scrapeBudget.used
  result.durationMs = Date.now() - startedAt
  return result
}

// ────────────────────────────── Intelligent reactivation ──────────────────────────────
//
// Dormant candidates (deactivated long ago) periodically get a low-frequency re-validation.
// Products/niches can become viable again later — we don't rediscover from scratch, we revive.

export async function reactivateDormantCandidates(batch: number): Promise<{ revalidated: number; reactivated: number }> {
  await ensureDiscoveryColumns()
  if (batch <= 0) return { revalidated: 0, reactivated: 0 }

  // Stamp dormant_at for any inactive rows that don't have it yet (one-time backfill per row).
  await sql`
    UPDATE product_source_items
    SET dormant_at = COALESCE(dormant_at, last_seen_at, NOW())
    WHERE active = FALSE AND dormant_at IS NULL
  `.catch(() => {})

  // Pick the oldest-dormant rows that haven't been revalidated recently and weren't hard-rejected
  // for a permanent reason (we keep ASIN_MISMATCH / reject out of rotation).
  const rows = await queryRows<{ asin: string; amazon_price: string | number }>`
    SELECT asin, amazon_price
    FROM product_source_items
    WHERE active = FALSE
      AND COALESCE(source_quality, '') <> 'reject'
      AND (last_validated_at IS NULL OR last_validated_at < NOW() - INTERVAL '14 days')
    ORDER BY last_validated_at ASC NULLS FIRST, dormant_at ASC NULLS FIRST
    LIMIT ${batch}
  `.catch(() => [])

  let revalidated = 0
  let reactivated = 0
  const { fetchProductDetailsFromApi } = await import('@/lib/amazon-product')
  const { getThrottleState } = await import('@/lib/quota-tracker')

  // Reactivation revalidation uses the (paid) detail API — respect the rapidapi quota gate.
  const quotaState = await getThrottleState('rapidapi').catch(() => 'ok' as const)
  if (quotaState !== 'ok') return { revalidated: 0, reactivated: 0 }

  for (const row of rows) {
    revalidated++
    const detail = await fetchProductDetailsFromApi(row.asin).catch(() => null)
    await sql`
      UPDATE product_source_items
      SET last_validated_at = NOW(), revalidation_count = revalidation_count + 1
      WHERE asin = ${row.asin}
    `.catch(() => {})
    if (detail && detail.available && detail.amazonPrice > 0 && detail.amazonPrice <= MAX_COST) {
      const { profit } = calcMetrics(detail.amazonPrice)
      if (profit >= MIN_PROFIT) {
        await sql`
          UPDATE product_source_items
          SET active = TRUE, source_quality = 'candidate', dormant_at = NULL,
              amazon_price = ${detail.amazonPrice.toFixed(2)}, last_seen_at = NOW()
          WHERE asin = ${row.asin}
        `.catch(() => {})
        reactivated++
      }
    }
  }
  return { revalidated, reactivated }
}

// ────────────────────────────── Breadth metrics (read) ──────────────────────────────

export async function getSourcingBreadthMetrics() {
  await ensureDiscoveryColumns()

  const { getThrottleState } = await import('@/lib/quota-tracker')

  const [universe, freshness, sources, depthAnalytics, evergreenSplit, edges, funnel, rapidapiState] = await Promise.all([
    queryRows`
      SELECT
        COUNT(*)::int AS total_universe,
        COUNT(*) FILTER (WHERE active = TRUE)::int AS active,
        COUNT(*) FILTER (WHERE active = FALSE)::int AS dormant,
        COUNT(*) FILTER (WHERE source_quality = 'reject')::int AS rejected,
        COUNT(*) FILTER (WHERE enrichment_status = 'raw')::int AS raw_candidates,
        COUNT(*) FILTER (WHERE enrichment_status = 'enriched')::int AS enriched,
        COUNT(*) FILTER (WHERE enrichment_status = 'validated')::int AS validated,
        COUNT(*) FILTER (WHERE enrichment_status = 'enrich_failed')::int AS enrich_failed,
        COUNT(*) FILTER (WHERE active = TRUE AND dup_cluster_size > 1 AND dup_rank > 1)::int AS dup_suppressed
      FROM product_source_items
    `.catch(() => []),
    queryRows`
      SELECT
        COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '24 hours')::int AS new_24h,
        COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '7 days')::int AS new_7d,
        COUNT(*) FILTER (WHERE last_validated_at > NOW() - INTERVAL '24 hours' AND revalidation_count > 0)::int AS reactivated_24h
      FROM product_source_items
    `.catch(() => []),
    queryRows`
      SELECT COALESCE(discovery_source, 'search') AS source, COUNT(*)::int AS n
      FROM product_source_items
      WHERE active = TRUE
      GROUP BY COALESCE(discovery_source, 'search')
      ORDER BY n DESC
    `.catch(() => []),
    queryRows`
      SELECT
        discovery_depth AS depth,
        COUNT(*)::int AS candidates,
        COUNT(*) FILTER (WHERE enrichment_status IN ('enriched','validated'))::int AS enriched,
        COUNT(*) FILTER (WHERE source_quality = 'ready')::int AS list_ready,
        ROUND(AVG(roi), 1) AS avg_roi,
        ROUND(AVG(COALESCE(inventory_quality_score, 0)), 1) AS avg_quality
      FROM product_source_items
      WHERE active = TRUE
      GROUP BY discovery_depth
      ORDER BY discovery_depth ASC
    `.catch(() => []),
    queryRows`
      SELECT
        COUNT(*) FILTER (WHERE evergreen = TRUE AND active = TRUE)::int AS evergreen,
        COUNT(*) FILTER (WHERE evergreen = FALSE AND active = TRUE)::int AS seasonal
      FROM product_source_items
    `.catch(() => []),
    queryRows`
      SELECT COUNT(*)::int AS total_edges,
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS edges_24h
      FROM product_discovery_edges
    `.catch(() => []),
    // Conversion funnel: discovered → enriched → validated(list-ready) → listed.
    queryRows`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(source_quality, '') <> 'reject')::int AS discovered,
        COUNT(*) FILTER (WHERE enrichment_status IN ('enriched', 'validated'))::int AS enriched,
        COUNT(*) FILTER (WHERE source_quality = 'ready')::int AS list_ready,
        (SELECT COUNT(DISTINCT UPPER(asin))::int FROM listed_asins WHERE asin IS NOT NULL) AS listed
      FROM product_source_items
    `.catch(() => []),
    getThrottleState('rapidapi').catch(() => 'ok' as const),
  ])

  const f = funnel[0] || { discovered: 0, enriched: 0, list_ready: 0, listed: 0 }
  const num = (v: unknown) => { const n = Number(v || 0); return Number.isFinite(n) ? n : 0 }
  const rate = (a: number, b: number) => (b > 0 ? Number((a / b).toFixed(4)) : 0)

  return {
    universe: universe[0] || {},
    freshness: freshness[0] || {},
    sources,
    depthAnalytics,
    evergreenSplit: evergreenSplit[0] || {},
    edges: edges[0] || {},
    funnel: {
      discovered: num(f.discovered),
      enriched: num(f.enriched),
      listReady: num(f.list_ready),
      listed: num(f.listed),
      discoveredToEnriched: rate(num(f.enriched), num(f.discovered)),
      enrichedToValidated: rate(num(f.list_ready), num(f.enriched)),
      validatedToListed: rate(num(f.listed), num(f.list_ready)),
    },
    enrichmentQuotaState: rapidapiState as 'ok' | 'warn' | 'block',
  }
}
