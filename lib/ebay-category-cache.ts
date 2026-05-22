// eBay category lookup cache.
//
// The list-product endpoint normally fires 4 eBay API calls per listing to pick a
// category (getCategoryByAsin, getCategoryByComparableListings, getTaxonomyCategoryIds,
// getSuggestedCategoryIds). At >100 listings/day that's >400 calls, contributing to
// quota-exceeded failures. Most of those calls return the same result for the same
// ASIN, so we memoize the verified category selection here.
//
// Cache strategy:
//  - Key by ASIN (`asin:<ASIN>`). Only cache AFTER eBay accepted the category via
//    AddFixedPriceItem/Verify — never cache untried selections.
//  - 14-day TTL — long enough to amortize, short enough that we re-discover when
//    eBay re-bucketizes a niche or a category is split.
//  - Listing failures with leaf/category errors invalidate the cached entry.

import { queryRows, sql } from '@/lib/db'

const CACHE_TTL_DAYS = 14

export interface CachedCategory {
  categoryId: string
  leafSuggestedIds: string[]
  sources: string[]
}

export async function ensureEbayCategoryCacheTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS ebay_category_cache (
      cache_key TEXT PRIMARY KEY,
      category_id TEXT NOT NULL,
      leaf_suggested_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      hits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `.catch(() => {})
  await sql`CREATE INDEX IF NOT EXISTS ebay_category_cache_expires_idx ON ebay_category_cache (expires_at)`.catch(() => {})
}

function cacheKeyForAsin(asin: string) {
  return `asin:${String(asin || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)}`
}

/** Returns cached category if present and unexpired. Increments hit counter. */
export async function getCachedCategoryByAsin(asin: string): Promise<CachedCategory | null> {
  if (!asin) return null
  await ensureEbayCategoryCacheTable()
  const key = cacheKeyForAsin(asin)
  const rows = await queryRows<{
    category_id: string
    leaf_suggested_ids: unknown
    sources: unknown
  }>`
    UPDATE ebay_category_cache
    SET hits = hits + 1, updated_at = NOW()
    WHERE cache_key = ${key} AND expires_at > NOW()
    RETURNING category_id, leaf_suggested_ids, sources
  `.catch(() => [])
  const row = rows[0]
  if (!row) return null
  return {
    categoryId: row.category_id,
    leafSuggestedIds: Array.isArray(row.leaf_suggested_ids) ? (row.leaf_suggested_ids as string[]) : [],
    sources: Array.isArray(row.sources) ? (row.sources as string[]) : [],
  }
}

/** Writes a successfully-verified category lookup result to the cache. */
export async function setCachedCategoryByAsin(asin: string, data: CachedCategory) {
  if (!asin || !data.categoryId) return
  await ensureEbayCategoryCacheTable()
  const key = cacheKeyForAsin(asin)
  await sql`
    INSERT INTO ebay_category_cache (cache_key, category_id, leaf_suggested_ids, sources, expires_at)
    VALUES (
      ${key},
      ${data.categoryId},
      ${JSON.stringify(data.leafSuggestedIds || [])}::jsonb,
      ${JSON.stringify(data.sources || [])}::jsonb,
      NOW() + (${CACHE_TTL_DAYS} || ' days')::interval
    )
    ON CONFLICT (cache_key) DO UPDATE SET
      category_id = EXCLUDED.category_id,
      leaf_suggested_ids = EXCLUDED.leaf_suggested_ids,
      sources = EXCLUDED.sources,
      updated_at = NOW(),
      expires_at = NOW() + (${CACHE_TTL_DAYS} || ' days')::interval
  `.catch(() => {})
}

/** Invalidates a cached entry — call when a listing fails with leaf/category errors so we re-discover next time. */
export async function invalidateCachedCategoryByAsin(asin: string) {
  if (!asin) return
  await ensureEbayCategoryCacheTable()
  const key = cacheKeyForAsin(asin)
  await sql`DELETE FROM ebay_category_cache WHERE cache_key = ${key}`.catch(() => {})
}

/** Diagnostic: stats for an admin dashboard. */
export async function getCategoryCacheStats() {
  await ensureEbayCategoryCacheTable()
  const rows = await queryRows<{
    total: string | number
    active: string | number
    total_hits: string | number
    avg_hits: string | number
  }>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE expires_at > NOW())::int AS active,
      COALESCE(SUM(hits), 0)::int AS total_hits,
      COALESCE(ROUND(AVG(hits), 2), 0) AS avg_hits
    FROM ebay_category_cache
  `.catch(() => [])
  return rows[0] || { total: 0, active: 0, total_hits: 0, avg_hits: 0 }
}
