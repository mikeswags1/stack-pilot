// "Top 100 Listings We Should Have Listed" — apply Rules A/B/C/D backward
// against the current pool to surface what winning inventory actually looks like.
//
// Rules:
//   A: niche NOT in blacklist (≥70% END niches from prior analysis)
//   B: niche-level avg competitor count < 500
//   C: amazon_cost / comp_min < 1.65
//   D: net margin at competitive price ≥ $4
//
// Score listings that pass all 4 by: net_margin × (1 / log(competitors + 2))
// (favors high margin AND low competition without exploding for 0-comp items).

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

// Load latest proposal to derive Rule A blacklist + Rule B saturation map
const proposalsDir = 'scripts/proposals'
const files = fs.readdirSync(proposalsDir).filter((f) => f.startsWith('dynamic-pricing-proposal-')).sort().reverse()
const latest = JSON.parse(fs.readFileSync(path.join(proposalsDir, files[0]), 'utf-8'))

const niches = latest.niche_breakdown || []
const blacklist = new Set(niches.filter((n) => n.end_pct >= 70 && n.total >= 10).map((n) => n.niche))
const nicheAvgComp = new Map(niches.map((n) => [n.niche, n.avg_comp_count]))
console.log(`Rule A blacklist: ${blacklist.size} niches`)
console.log(`Rule B saturation cap: avg comp ≥ 500\n`)

const EBAY_FEE_RATE = 0.13
const PAYMENT_FEE_RATE = 0.029
const FIXED_FEE = 0.30
const SHIP = 3.0

function netProfit(sale, cost) {
  return sale - cost - (sale * (EBAY_FEE_RATE + PAYMENT_FEE_RATE) + FIXED_FEE) - SHIP
}

// Pull every active listing with the data needed to apply all 4 rules
const rows = await sql(`
  SELECT la.id, la.ebay_listing_id, la.asin, LEFT(la.title, 70) AS title,
         COALESCE(la.niche, '(no niche)') AS niche,
         la.ebay_price::float current_price,
         la.amazon_price::float amazon_cost,
         psi.ebay_competitor_min_price::float comp_min,
         psi.ebay_competitor_count AS comp_count
  FROM listed_asins la
  JOIN product_source_items psi ON UPPER(psi.asin) = UPPER(la.asin)
  WHERE la.ended_at IS NULL
    AND la.amazon_price IS NOT NULL AND la.amazon_price > 0
    AND psi.ebay_competitor_min_price IS NOT NULL AND psi.ebay_competitor_min_price > 0
`)
console.log(`Active listings with full data: ${rows.length}\n`)

const filterStats = { ruleA: 0, ruleB: 0, ruleC: 0, ruleD: 0, passed: 0 }
const winners = []

for (const r of rows) {
  // Rule A
  if (blacklist.has(r.niche)) { filterStats.ruleA++; continue }
  // Rule B
  const nicheComp = nicheAvgComp.get(r.niche) || 0
  if (nicheComp >= 500) { filterStats.ruleB++; continue }
  // Rule C
  const costRatio = r.amazon_cost / r.comp_min
  if (costRatio >= 1.65) { filterStats.ruleC++; continue }
  // Rule D
  const competitivePrice = Math.max(r.comp_min - 0.50, r.amazon_cost + 4)
  const profit = netProfit(competitivePrice, r.amazon_cost)
  if (profit < 4) { filterStats.ruleD++; continue }

  filterStats.passed++
  const score = profit / Math.log(Number(r.comp_count || 1) + 2)
  winners.push({
    ...r,
    competitive_price: Number(competitivePrice.toFixed(2)),
    proposed_profit: Number(profit.toFixed(2)),
    cost_ratio: Number(costRatio.toFixed(2)),
    score: Number(score.toFixed(3)),
  })
}

console.log('=== FILTER FUNNEL ===')
console.log(`  Rule A (blacklisted niche):     dropped ${filterStats.ruleA}`)
console.log(`  Rule B (saturation >=500):      dropped ${filterStats.ruleB}`)
console.log(`  Rule C (cost ratio >=1.65):     dropped ${filterStats.ruleC}`)
console.log(`  Rule D (margin <$4):            dropped ${filterStats.ruleD}`)
console.log(`  PASSED ALL RULES:               ${filterStats.passed}`)
console.log(`  (${(filterStats.passed * 100 / rows.length).toFixed(1)}% of active inventory qualifies as "winning")`)

winners.sort((a, b) => b.score - a.score)

// Niche breakdown of winners
const nicheCounts = new Map()
for (const w of winners) nicheCounts.set(w.niche, (nicheCounts.get(w.niche) || 0) + 1)
console.log('\n=== WINNERS BY NICHE (top 15) ===')
const nicheList = [...nicheCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
for (const [niche, n] of nicheList) {
  console.log(`  ${niche.padEnd(38).slice(0, 38)} ${n}`)
}

// Aggregate stats
const totalProfitOp = winners.reduce((s, w) => s + w.proposed_profit, 0)
const avgComp = winners.reduce((s, w) => s + Number(w.comp_count || 0), 0) / winners.length
console.log('\n=== AGGREGATE OPPORTUNITY (all qualifiers) ===')
console.log(`  Qualifying listings:              ${winners.length}`)
console.log(`  Total annualized profit opp (if each sold 1×): $${totalProfitOp.toFixed(0)}`)
console.log(`  Avg net margin at competitive price:  $${(totalProfitOp / winners.length).toFixed(2)}`)
console.log(`  Avg competitor count:                 ${Math.round(avgComp)}`)

console.log('\n=== TOP 100 LISTINGS WE SHOULD HAVE LISTED ===')
console.log(`  #   listing_id    niche                    Amazon    eBay     comp_min  comp   margin    cost%   score   title`)
for (let i = 0; i < Math.min(100, winners.length); i++) {
  const w = winners[i]
  console.log(
    `  ${String(i + 1).padStart(3)} ${w.ebay_listing_id}` +
    `  ${w.niche.padEnd(24).slice(0, 24)}` +
    `  $${String(w.amazon_cost.toFixed(2)).padStart(6)}` +
    `  $${String(w.current_price.toFixed(2)).padStart(6)}` +
    `  $${String(w.comp_min.toFixed(2)).padStart(6)}` +
    `  ${String(w.comp_count || 0).padStart(4)}` +
    `  $${String(w.proposed_profit.toFixed(2)).padStart(5)}` +
    `   ${(w.cost_ratio * 100).toFixed(0)}%` +
    `   ${String(w.score.toFixed(2)).padStart(5)}` +
    `   ${w.title.slice(0, 45)}`,
  )
}

const out = `scripts/proposals/top-100-listings-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
fs.writeFileSync(out, JSON.stringify({
  generated_at: new Date().toISOString(),
  rules: { A: 'niche NOT in blacklist', B: 'avg comp < 500', C: 'cost / comp_min < 1.65', D: 'net margin >= $4' },
  filter_funnel: filterStats,
  total_qualifying: winners.length,
  top_100: winners.slice(0, 100),
  all_qualifying: winners,
}, null, 2))
console.log(`\nFull ranked list saved to ${out}`)
