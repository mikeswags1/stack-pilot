// Check new master_score distribution after backfill
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

const dist = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE master_score >= 80)::int AS tier_a_80_plus,
    COUNT(*) FILTER (WHERE master_score >= 65 AND master_score < 80)::int AS tier_b_65_79,
    COUNT(*) FILTER (WHERE master_score >= 50 AND master_score < 65)::int AS tier_c_50_64,
    COUNT(*) FILTER (WHERE master_score >= 38 AND master_score < 50)::int AS tier_d_38_49,
    COUNT(*) FILTER (WHERE master_score IS NULL)::int AS still_null,
    COUNT(*) FILTER (WHERE master_score < 38)::int AS below_floor_remaining,
    COUNT(*)::int AS total_active,
    ROUND(AVG(master_score), 2) AS avg_score,
    ROUND(MAX(master_score), 2) AS max_score
  FROM product_source_items WHERE active = TRUE
`)
console.log('Master score distribution AFTER backfill:')
console.log(JSON.stringify(dist[0], null, 2))

const topAfter = await sql(`
  SELECT asin, source_niche, ROUND(master_score, 1) AS score, ROUND(profit, 2) AS profit,
         ROUND(roi, 1) AS roi, rating, review_count, LEFT(title, 70) AS title_preview
  FROM product_source_items
  WHERE active = TRUE
  ORDER BY master_score DESC NULLS LAST LIMIT 10
`)
console.log('\nTop 10 products by NEW masterScore:')
for (const r of topAfter) console.log(`  [${r.score} | $${r.profit} | ${r.roi}% ROI] ${r.source_niche} — ${r.title_preview}`)
