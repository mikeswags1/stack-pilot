// Dynamic-pricing simulation v2 — Balanced threshold (1.25 / +$4 / 1.12 unwinnable).
// Fields use snake_case from Postgres. Adds per-niche outcome breakdown so the END
// distribution informs category-level sourcing rules.

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

// Balanced strategy parameters
const COST_MULT = 1.25
const MIN_PROFIT = 4
const UNWINNABLE_RATIO = 1.12

const EBAY_FEE_RATE = 0.13
const PAYMENT_FEE_RATE = 0.029
const FIXED_FEE = 0.30
const SHIP_COST_ESTIMATE = 3.0

function netProfit(salePrice, amazonCost) {
  const fees = salePrice * (EBAY_FEE_RATE + PAYMENT_FEE_RATE) + FIXED_FEE
  return salePrice - amazonCost - fees - SHIP_COST_ESTIMATE
}

function simulate(amazonCost, currentPrice, competitorMin) {
  const floor = Math.max(
    amazonCost * COST_MULT,
    amazonCost + MIN_PROFIT,
    competitorMin * 0.95,
  )
  const target = competitorMin - 0.50
  const proposed = Math.max(floor, target)

  let outcome
  if (floor > competitorMin * UNWINNABLE_RATIO) outcome = 'END'
  else if (proposed < currentPrice - 0.25) outcome = 'REPRICE_DOWN'
  else if (proposed > currentPrice + 0.25) outcome = 'REPRICE_UP'
  else outcome = 'KEEP'

  return {
    floor: Number(floor.toFixed(2)),
    target: Number(target.toFixed(2)),
    proposed: Number(proposed.toFixed(2)),
    outcome,
    current_profit: Number(netProfit(currentPrice, amazonCost).toFixed(2)),
    proposed_profit: outcome === 'END' ? 0 : Number(netProfit(proposed, amazonCost).toFixed(2)),
  }
}

const rows = await sql(`
  SELECT la.id, la.ebay_listing_id, la.asin, LEFT(la.title, 60) AS title,
         COALESCE(la.niche, '(no niche)') AS niche,
         la.ebay_price::float AS current_price,
         la.amazon_price::float AS amazon_cost,
         psi.ebay_competitor_min_price::float AS comp_min,
         psi.ebay_competitor_count AS comp_count
  FROM listed_asins la
  JOIN product_source_items psi ON UPPER(psi.asin) = UPPER(la.asin)
  WHERE la.ended_at IS NULL
    AND la.amazon_price IS NOT NULL AND la.amazon_price > 0
    AND psi.ebay_competitor_min_price IS NOT NULL AND psi.ebay_competitor_min_price > 0
    AND la.ebay_price IS NOT NULL AND la.ebay_price > 0
`)

console.log('==================================================')
console.log(`  DYNAMIC PRICING SIMULATION — Balanced threshold`)
console.log(`  Floor: MAX(amazon×${COST_MULT}, amazon+$${MIN_PROFIT}, comp_min×0.95)`)
console.log(`  End if floor > comp_min × ${UNWINNABLE_RATIO}`)
console.log(`  Simulated against ${rows.length} active listings with full data`)
console.log('==================================================\n')

const proposals = rows.map((r) => {
  const sim = simulate(r.amazon_cost, r.current_price, r.comp_min)
  return { ...r, ...sim, profit_delta: Number((sim.proposed_profit - sim.current_profit).toFixed(2)) }
})

const byOutcome = { KEEP: [], REPRICE_DOWN: [], REPRICE_UP: [], END: [] }
for (const p of proposals) byOutcome[p.outcome].push(p)

console.log('=== OUTCOME COUNTS ===')
for (const o of ['KEEP', 'REPRICE_DOWN', 'REPRICE_UP', 'END']) {
  console.log(`  ${o.padEnd(15)} ${String(byOutcome[o].length).padStart(5)}  (${(byOutcome[o].length * 100 / proposals.length).toFixed(0)}%)`)
}

const totalCurrentProfit = proposals.reduce((s, p) => s + p.current_profit, 0)
const totalProposedProfit = proposals.reduce((s, p) => s + p.proposed_profit, 0)
const repricedDownTotal = byOutcome.REPRICE_DOWN.reduce((s, p) => s + p.profit_delta, 0)
const endedLostProfit = byOutcome.END.reduce((s, p) => s + p.current_profit, 0)

console.log('\n=== MARGIN IMPACT (theoretical, if every listing sold once) ===')
console.log(`  Total profit at current prices:        $${totalCurrentProfit.toFixed(0)}`)
console.log(`  Total profit at proposed prices:       $${totalProposedProfit.toFixed(0)}`)
console.log(`  Theoretical delta:                     $${(totalProposedProfit - totalCurrentProfit).toFixed(0)}`)
console.log(`  ↳ from repricing (134 listings):       $${repricedDownTotal.toFixed(0)}`)
console.log(`  ↳ from ending unwinnables:             -$${endedLostProfit.toFixed(0)} (these aren't actually selling, so realized impact ≈ $0)`)

const cur = proposals.filter((p) => p.current_price / p.comp_min <= 1.05).length
const newCompetitive = proposals.filter((p) => p.outcome !== 'END' && p.proposed / p.comp_min <= 1.05).length
console.log('\n=== SALES-LIFT INDICATOR ===')
console.log(`  Currently within 5% of competitor min:   ${cur}  (${(cur * 100 / proposals.length).toFixed(0)}%)`)
console.log(`  After repricing within 5% of comp min:   ${newCompetitive}  (${(newCompetitive * 100 / proposals.length).toFixed(0)}%)`)
console.log(`  Newly competitive listings:              +${newCompetitive - cur}`)

// === PER-NICHE BREAKDOWN ===
const byNiche = new Map()
for (const p of proposals) {
  if (!byNiche.has(p.niche)) {
    byNiche.set(p.niche, {
      total: 0, END: 0, REPRICE_DOWN: 0, REPRICE_UP: 0, KEEP: 0,
      sum_comp: 0, sum_margin_delta: 0, sum_amazon: 0,
      currently_competitive: 0,
    })
  }
  const b = byNiche.get(p.niche)
  b.total++
  b[p.outcome]++
  b.sum_comp += Number(p.comp_count || 0)
  b.sum_margin_delta += p.profit_delta
  b.sum_amazon += Number(p.amazon_cost || 0)
  if (p.current_price / p.comp_min <= 1.05) b.currently_competitive++
}
const niches = [...byNiche.entries()]
  .map(([niche, b]) => ({
    niche,
    total: b.total,
    END: b.END,
    REPRICE_DOWN: b.REPRICE_DOWN,
    REPRICE_UP: b.REPRICE_UP,
    KEEP: b.KEEP,
    currently_competitive: b.currently_competitive,
    avg_comp_count: Math.round(b.sum_comp / b.total),
    avg_margin_delta: Number((b.sum_margin_delta / b.total).toFixed(2)),
    avg_amazon_cost: Number((b.sum_amazon / b.total).toFixed(2)),
    end_pct: b.END * 100 / b.total,
    viable_pct: (b.REPRICE_DOWN + b.REPRICE_UP + b.KEEP) * 100 / b.total,
  }))
  .filter((n) => n.total >= 5) // ignore noise

console.log('\n=== PER-NICHE SOURCE-QUALITY ANALYSIS (worst 15 by END%) ===')
const worstNiches = [...niches].sort((a, b) => b.end_pct - a.end_pct).slice(0, 15)
console.log(`  niche                              n   END  REPR   END%   avgComp  avgAmazon  avgΔ`)
for (const n of worstNiches) {
  console.log(
    `  ${n.niche.padEnd(34).slice(0, 34)}` +
    ` ${String(n.total).padStart(3)}` +
    ` ${String(n.END).padStart(4)}` +
    ` ${String(n.REPRICE_DOWN + n.REPRICE_UP).padStart(5)}` +
    `   ${String(n.end_pct.toFixed(0)).padStart(3)}%` +
    `   ${String(n.avg_comp_count).padStart(6)}` +
    `   $${String(n.avg_amazon_cost.toFixed(2)).padStart(7)}` +
    `  $${String(n.avg_margin_delta.toFixed(2)).padStart(5)}`)
}

console.log('\n=== PER-NICHE SOURCE-QUALITY ANALYSIS (best 15 by viable %) ===')
const bestNiches = [...niches].sort((a, b) => b.viable_pct - a.viable_pct).slice(0, 15)
console.log(`  niche                              n   END  REPR   END%   avgComp  avgAmazon  avgΔ`)
for (const n of bestNiches) {
  console.log(
    `  ${n.niche.padEnd(34).slice(0, 34)}` +
    ` ${String(n.total).padStart(3)}` +
    ` ${String(n.END).padStart(4)}` +
    ` ${String(n.REPRICE_DOWN + n.REPRICE_UP).padStart(5)}` +
    `   ${String(n.end_pct.toFixed(0)).padStart(3)}%` +
    `   ${String(n.avg_comp_count).padStart(6)}` +
    `   $${String(n.avg_amazon_cost.toFixed(2)).padStart(7)}` +
    `  $${String(n.avg_margin_delta.toFixed(2)).padStart(5)}`)
}

console.log('\n=== TOP NICHES BY AVG PROFIT OPPORTUNITY (Δprofit per repriced listing) ===')
const byProfitOpp = [...niches]
  .filter((n) => (n.REPRICE_DOWN + n.REPRICE_UP + n.KEEP) >= 5) // only niches that ARE winnable somewhere
  .sort((a, b) => b.avg_margin_delta - a.avg_margin_delta)
  .slice(0, 10)
console.log(`  niche                              n   END%   avgComp   avgAmazon   avgΔprofit`)
for (const n of byProfitOpp) {
  console.log(
    `  ${n.niche.padEnd(34).slice(0, 34)}` +
    ` ${String(n.total).padStart(3)}` +
    `   ${String(n.end_pct.toFixed(0)).padStart(3)}%` +
    `   ${String(n.avg_comp_count).padStart(6)}` +
    `   $${String(n.avg_amazon_cost.toFixed(2)).padStart(7)}` +
    `  $${String(n.avg_margin_delta.toFixed(2)).padStart(6)}`)
}

console.log('\n=== TOP NICHES BY HIGHEST COMPETITIVE-LISTING RATE (sourcing winners) ===')
const byCompetitiveRate = [...niches]
  .filter((n) => n.total >= 10)
  .sort((a, b) => (b.currently_competitive / b.total) - (a.currently_competitive / a.total))
  .slice(0, 10)
console.log(`  niche                              n   competitive   rate`)
for (const n of byCompetitiveRate) {
  const rate = n.currently_competitive * 100 / n.total
  console.log(`  ${n.niche.padEnd(34).slice(0, 34)} ${String(n.total).padStart(3)}   ${String(n.currently_competitive).padStart(11)}   ${rate.toFixed(0)}%`)
}

// === DERIVED SOURCING RULES ===
console.log('\n=== DATA-DERIVED SOURCING RULES ===')
const skipNiches = niches.filter((n) => n.end_pct >= 70 && n.total >= 10).map((n) => n.niche)
console.log(`\n  RULE A: Stop sourcing these niches (≥70% END rate, n≥10):`)
if (skipNiches.length === 0) console.log(`    (none meet the threshold yet)`)
for (const n of skipNiches) console.log(`    - ${n}`)

const highSatNiches = niches.filter((n) => n.avg_comp_count >= 200 && n.end_pct >= 50)
console.log(`\n  RULE B: Saturation guard — niches with avg competitors ≥200 AND END% ≥50%:`)
if (highSatNiches.length === 0) console.log(`    (none meet the threshold)`)
for (const n of highSatNiches) console.log(`    - ${n.niche} (avg ${n.avg_comp_count} competitors)`)

const allEnded = byOutcome.END
const endedAvgAmazon = allEnded.length ? allEnded.reduce((s, p) => s + Number(p.amazon_cost || 0), 0) / allEnded.length : 0
const endedAvgCompMin = allEnded.length ? allEnded.reduce((s, p) => s + Number(p.comp_min || 0), 0) / allEnded.length : 0
const endedRatio = endedAvgCompMin > 0 ? endedAvgAmazon / endedAvgCompMin : 0
console.log(`\n  RULE C: Per-product cost-vs-market floor (derived from END distribution):`)
console.log(`    Across all ${allEnded.length} ENDED listings: avg Amazon cost $${endedAvgAmazon.toFixed(2)}, avg competitor min $${endedAvgCompMin.toFixed(2)}, ratio ${endedRatio.toFixed(2)}`)
console.log(`    → Sourcing rule: SKIP any product where Amazon cost ≥ ${endedRatio.toFixed(2)} × competitor min on eBay`)

console.log(`\n  RULE D: Minimum gross margin floor (informed by ${MIN_PROFIT} threshold):`)
console.log(`    Require (proposed_ebay_price × 0.86) - amazon_cost ≥ $${MIN_PROFIT} before allowing a listing`)
console.log(`    (the 0.86 accounts for eBay 13% + payment 3% fees)`)

// === LISTING SLOT EFFICIENCY ===
const totalActive = await sql(`SELECT COUNT(*)::int n FROM listed_asins WHERE ended_at IS NULL`)
const slotsToFree = byOutcome.END.length
const slotsRemaining = totalActive[0].n - slotsToFree
console.log('\n=== LISTING SLOT EFFICIENCY (impact of ending unwinnables) ===')
console.log(`  Active listings now:                ${totalActive[0].n}`)
console.log(`  Slots freed by ending unwinnables:  ${slotsToFree}`)
console.log(`  Active listings after:              ${slotsRemaining}`)
console.log(`  Reprice API calls saved per cycle:  ~${slotsToFree} (Trading API, ~1 per listing per repricer pass)`)
console.log(`  Browse refresh saved per 72h cycle: ~${slotsToFree} (saturation re-check)`)
console.log(`  Weekly maintenance touches saved:   ~${slotsToFree * 7} (across availability/image/reprice checks)`)

console.log('\n=== SAMPLE: 6 worst-overpriced (will REPRICE_DOWN) ===')
const worst = [...byOutcome.REPRICE_DOWN]
  .sort((a, b) => (b.current_price / b.comp_min) - (a.current_price / a.comp_min))
  .slice(0, 6)
for (const p of worst) {
  console.log(`  ${p.ebay_listing_id} | $${p.current_price} → $${p.proposed} (${(p.current_price / p.comp_min).toFixed(1)}× → ${(p.proposed / p.comp_min).toFixed(2)}×) | Δprofit $${p.profit_delta} | ${p.title}`)
}

console.log('\n=== SAMPLE: 6 to END (cannot compete profitably) ===')
for (const p of byOutcome.END.slice(0, 6)) {
  console.log(`  ${p.ebay_listing_id} | listed $${p.current_price} | Amazon $${p.amazon_cost} | comp min $${p.comp_min} | floor $${p.floor} | ${p.title}`)
}

console.log('\n=== SAMPLE: 6 to REPRICE_UP (currently underpriced) ===')
for (const p of byOutcome.REPRICE_UP.slice(0, 6)) {
  console.log(`  ${p.ebay_listing_id} | $${p.current_price} → $${p.proposed} | Δprofit +$${p.profit_delta} | ${p.title}`)
}

const out = `scripts/proposals/dynamic-pricing-proposal-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
fs.mkdirSync('scripts/proposals', { recursive: true })
fs.writeFileSync(out, JSON.stringify({
  generated_at: new Date().toISOString(),
  strategy: 'Balanced',
  parameters: { cost_multiplier: COST_MULT, min_profit: MIN_PROFIT, unwinnable_ratio: UNWINNABLE_RATIO },
  fee_assumptions: { ebay: EBAY_FEE_RATE, payment: PAYMENT_FEE_RATE, fixed: FIXED_FEE, ship: SHIP_COST_ESTIMATE },
  totals: {
    simulated: proposals.length,
    keep: byOutcome.KEEP.length,
    reprice_down: byOutcome.REPRICE_DOWN.length,
    reprice_up: byOutcome.REPRICE_UP.length,
    end: byOutcome.END.length,
    competitive_before: cur,
    competitive_after: newCompetitive,
    theoretical_profit_delta: Number((totalProposedProfit - totalCurrentProfit).toFixed(2)),
  },
  niche_breakdown: niches.sort((a, b) => b.total - a.total),
  proposals,
}, null, 2))
console.log(`\nFull proposal saved to ${out}`)
