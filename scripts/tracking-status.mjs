import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)
const r = await sql(`
  SELECT
    COUNT(*)::int active,
    COUNT(*) FILTER (WHERE sold_at IS NOT NULL)::int with_sales,
    COUNT(*) FILTER (WHERE quantity_sold > 0)::int has_qty_sold,
    COALESCE(SUM(quantity_sold), 0)::int total_units,
    COALESCE(SUM(realized_profit), 0)::numeric(10,2) total_profit,
    COUNT(*) FILTER (WHERE watch_count > 0)::int with_watchers,
    COALESCE(SUM(watch_count), 0)::int total_watchers,
    COUNT(*) FILTER (WHERE hit_count > 0)::int with_hits,
    COALESCE(SUM(hit_count), 0)::int total_hits,
    COUNT(*) FILTER (WHERE engagement_checked_at IS NOT NULL)::int eng_checked,
    COUNT(*) FILTER (WHERE engagement_checked_at > NOW() - INTERVAL '7 days')::int eng_checked_recent
  FROM listed_asins WHERE ended_at IS NULL`)
const d = r[0]
console.log('AFTER outcome-tracker run, listed_asins state (active only):')
console.log(`  Active listings:                ${d.active}`)
console.log(`  With sales recorded:            ${d.with_sales}`)
console.log(`  With quantity_sold > 0:         ${d.has_qty_sold}`)
console.log(`  Total units sold (all-time):    ${d.total_units}`)
console.log(`  Total realized profit:          $${d.total_profit}`)
console.log(`  With watchers > 0:              ${d.with_watchers}`)
console.log(`  Total watcher count:            ${d.total_watchers}`)
console.log(`  With hit_count > 0:             ${d.with_hits}`)
console.log(`  Total hit count:                ${d.total_hits}`)
console.log(`  Engagement EVER checked:        ${d.eng_checked}  (${(d.eng_checked*100/d.active).toFixed(0)}% coverage)`)
console.log(`  Engagement checked last 7d:     ${d.eng_checked_recent}`)
console.log(`  → Stale (never checked):        ${d.active - d.eng_checked}`)
