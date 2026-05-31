import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)
const runId = process.argv[2] || 'r1780189238620_glj8qa'

const funnel = await sql(`SELECT outcome, COUNT(*)::int n FROM demand_scout_trace WHERE run_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [runId])
console.log(`=== FUNNEL for ${runId} ===`)
for (const r of funnel) console.log(`  ${String(r.outcome).padEnd(22)} ${r.n}`)

const rows = await sql(`SELECT outcome, seed_query, LEFT(ebay_title,50) ebay_title, ebay_min_price, amazon_query, amazon_asin, amazon_price, amazon_source, margin_ratio, LEFT(reason,80) reason FROM demand_scout_trace WHERE run_id=$1 ORDER BY id`, [runId])
console.log(`\n=== ALL ${rows.length} ROWS ===`)
for (const r of rows) {
  console.log(`\n[${r.outcome}] seed: "${r.seed_query}"`)
  if (r.ebay_title) console.log(`  eBay: ${r.ebay_title} (min $${r.ebay_min_price})`)
  if (r.amazon_query) console.log(`  Amazon query: "${r.amazon_query}" → source=${r.amazon_source}`)
  if (r.amazon_asin) console.log(`  Amazon match: ${r.amazon_asin} $${r.amazon_price} (ratio ${r.margin_ratio})`)
  if (r.reason) console.log(`  Reason: ${r.reason}`)
}
