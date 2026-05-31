// Deep analysis of the 852 listings flagged END. Answers: have they sold?
// generated traffic? earned revenue? how concentrated by category? are they
// dominated by books/media? Determines whether ending is the right call
// category-by-category vs. wholesale.

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

// Load the latest proposal
const proposalsDir = 'scripts/proposals'
const files = fs.readdirSync(proposalsDir).filter((f) => f.startsWith('dynamic-pricing-proposal-')).sort().reverse()
const latest = JSON.parse(fs.readFileSync(path.join(proposalsDir, files[0]), 'utf-8'))
const endIds = latest.proposals.filter((p) => p.outcome === 'END').map((p) => p.id)
console.log(`Loaded ${endIds.length} END candidates from ${files[0]}\n`)

// 1. HISTORICAL PERFORMANCE
const perf = await sql(`
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (WHERE sold_at IS NOT NULL)::int ever_sold,
    COALESCE(SUM(quantity_sold), 0)::int total_units_sold,
    COALESCE(SUM(realized_profit), 0)::numeric(10,2) total_realized_profit,
    COUNT(*) FILTER (WHERE watch_count > 0)::int has_watchers,
    COALESCE(SUM(watch_count), 0)::int total_watchers,
    COUNT(*) FILTER (WHERE hit_count > 0)::int has_hits,
    COALESCE(SUM(hit_count), 0)::int total_hits,
    COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - listed_at))/86400), 0)::numeric(6,1) avg_days_listed,
    COUNT(*) FILTER (WHERE cancel_count > 0)::int has_cancels,
    COUNT(*) FILTER (WHERE refund_count > 0)::int has_refunds
  FROM listed_asins WHERE id = ANY($1::int[])`, [endIds])
const pf = perf[0]
console.log('=== 1. HISTORICAL PERFORMANCE (END bucket) ===')
console.log(`  Total listings flagged END:           ${pf.total}`)
console.log(`  Avg days listed:                      ${pf.avg_days_listed}`)
console.log(`  Ever sold:                            ${pf.ever_sold} (${(pf.ever_sold * 100 / pf.total).toFixed(1)}%)`)
console.log(`  Total units sold (all-time):          ${pf.total_units_sold}`)
console.log(`  Total realized profit (all-time):     $${pf.total_realized_profit}`)
console.log(`  Listings with any watchers:           ${pf.has_watchers} (${(pf.has_watchers * 100 / pf.total).toFixed(1)}%)`)
console.log(`  Total watcher count:                  ${pf.total_watchers}`)
console.log(`  Listings with hits/views:             ${pf.has_hits} (${(pf.has_hits * 100 / pf.total).toFixed(1)}%)`)
console.log(`  Total hit count:                      ${pf.total_hits}`)
console.log(`  Listings with cancellations:          ${pf.has_cancels}`)
console.log(`  Listings with refunds:                ${pf.has_refunds}`)

// 2. CATEGORY CONCENTRATION
const cats = await sql(`
  SELECT COALESCE(niche, '(no niche)') AS niche, COUNT(*)::int n
  FROM listed_asins WHERE id = ANY($1::int[])
  GROUP BY niche ORDER BY n DESC LIMIT 20`, [endIds])
console.log('\n=== 2. CATEGORY CONCENTRATION (top 20 niches in END bucket) ===')
let cumN = 0
for (const c of cats) {
  cumN += c.n
  console.log(`  ${String(c.niche).padEnd(38).slice(0, 38)} ${String(c.n).padStart(4)}  (cum ${(cumN * 100 / pf.total).toFixed(0)}%)`)
}

// 3. PERCENTAGE BOOKS / MEDIA
const bookKeywords = ['book', 'guide', 'manual', 'media', 'literature', 'magazine', 'novel', 'series']
const bookLike = await sql(`
  WITH e AS (SELECT id, LOWER(COALESCE(niche, '')) niche, LOWER(title) title FROM listed_asins WHERE id = ANY($1::int[]))
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (
      WHERE niche ~ '(book|guide|manual|media|literature|series)'
         OR title ~ '\\m(book|guide|manual|stories|tales|edition|series)\\M'
    )::int looks_like_book,
    COUNT(*) FILTER (WHERE niche ~ '(coin|currency|trading card|memorab)')::int collectible
  FROM e`, [endIds])
const bl = bookLike[0]
console.log('\n=== 3. BOOKS / MEDIA / COLLECTIBLES SHARE ===')
console.log(`  END listings matching book/media patterns:  ${bl.looks_like_book}  (${(bl.looks_like_book * 100 / bl.total).toFixed(0)}%)`)
console.log(`  END listings in collectibles niches:        ${bl.collectible}  (${(bl.collectible * 100 / bl.total).toFixed(0)}%)`)
console.log(`  → Combined unwinnable-by-format share:      ${bl.looks_like_book + bl.collectible}  (${((bl.looks_like_book + bl.collectible) * 100 / bl.total).toFixed(0)}%)`)

// 4. REVENUE CONTRIBUTION
const revenue = await sql(`
  WITH e AS (SELECT id, sold_at, sale_price, quantity_sold, realized_profit, ebay_price FROM listed_asins WHERE id = ANY($1::int[])),
  all_active AS (
    SELECT COALESCE(SUM(realized_profit), 0)::numeric tp,
           COUNT(*) FILTER (WHERE sold_at IS NOT NULL)::int sold
    FROM listed_asins WHERE ended_at IS NULL
  )
  SELECT
    (SELECT COALESCE(SUM(realized_profit), 0) FROM e) AS end_profit,
    (SELECT tp FROM all_active) AS all_profit,
    (SELECT sold FROM all_active) AS all_sold,
    (SELECT COUNT(*) FILTER (WHERE sold_at IS NOT NULL) FROM e) AS end_sold`, [endIds])
const rv = revenue[0]
const totalActive = 2180
const endShare = endIds.length / totalActive
console.log('\n=== 4. REVENUE CONTRIBUTION ===')
console.log(`  END bucket: ${endIds.length} listings = ${(endShare * 100).toFixed(0)}% of all active inventory`)
console.log(`  END bucket realized profit (all time): $${Number(rv.end_profit).toFixed(2)}`)
console.log(`  All-active realized profit (all time): $${Number(rv.all_profit).toFixed(2)}`)
const profitShare = Number(rv.all_profit) > 0 ? (Number(rv.end_profit) / Number(rv.all_profit)) * 100 : 0
console.log(`  END bucket's share of total profit:    ${profitShare.toFixed(1)}%`)
console.log(`  END bucket sales:                      ${rv.end_sold} of total ${rv.all_sold}`)
console.log(`  → Inventory-to-revenue efficiency: END holds ${(endShare*100).toFixed(0)}% of slots, generates ${profitShare.toFixed(1)}% of profit (${(profitShare/(endShare*100)).toFixed(2)}× efficiency ratio — anything <1 means it's dragging)`)

// 5. TRAFFIC CONTRIBUTION
const traffic = await sql(`
  WITH e AS (SELECT id, watch_count, hit_count FROM listed_asins WHERE id = ANY($1::int[])),
  all_active AS (
    SELECT COALESCE(SUM(watch_count), 0)::int aw, COALESCE(SUM(hit_count), 0)::int ah
    FROM listed_asins WHERE ended_at IS NULL
  )
  SELECT
    (SELECT COALESCE(SUM(watch_count), 0) FROM e) AS end_watchers,
    (SELECT COALESCE(SUM(hit_count), 0) FROM e) AS end_hits,
    (SELECT aw FROM all_active) AS all_watchers,
    (SELECT ah FROM all_active) AS all_hits`, [endIds])
const tr = traffic[0]
const watcherShare = Number(tr.all_watchers) > 0 ? (Number(tr.end_watchers) / Number(tr.all_watchers)) * 100 : 0
const hitShare = Number(tr.all_hits) > 0 ? (Number(tr.end_hits) / Number(tr.all_hits)) * 100 : 0
console.log('\n=== 5. TRAFFIC CONTRIBUTION ===')
console.log(`  END bucket watcher count:              ${tr.end_watchers}`)
console.log(`  All-active watcher count:              ${tr.all_watchers}`)
console.log(`  END share of total watchers:           ${watcherShare.toFixed(1)}%`)
console.log(`  END bucket hit count (eBay views):     ${tr.end_hits}`)
console.log(`  All-active hit count:                  ${tr.all_hits}`)
console.log(`  END share of total hits:               ${hitShare.toFixed(1)}%`)
console.log(`  → Slot share ${(endShare*100).toFixed(0)}% / hit share ${hitShare.toFixed(1)}% = ${hitShare > 0 ? (hitShare/(endShare*100)).toFixed(2) : 'N/A'}× traffic efficiency`)
