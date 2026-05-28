// Title quality + source pool quality audit
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

console.log('\n========== LISTING TITLE QUALITY ==========\n')

// 1. Distribution of title lengths
const lenDist = await sql(`
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE LENGTH(title) >= 80)::int AS at_max_80,
    COUNT(*) FILTER (WHERE LENGTH(title) >= 70 AND LENGTH(title) < 80)::int AS healthy_70_79,
    COUNT(*) FILTER (WHERE LENGTH(title) >= 50 AND LENGTH(title) < 70)::int AS medium_50_69,
    COUNT(*) FILTER (WHERE LENGTH(title) < 50)::int AS short_under_50,
    ROUND(AVG(LENGTH(title)), 1) AS avg_length,
    MIN(LENGTH(title))::int AS min_length,
    MAX(LENGTH(title))::int AS max_length
  FROM listed_asins WHERE ended_at IS NULL
`)
console.log('Active listing title length distribution:')
console.log(JSON.stringify(lenDist[0], null, 2))

// 2. Sample of long titles to check for mid-word truncation
const longTitles = await sql(`
  SELECT user_id, asin, title, LENGTH(title) AS len
  FROM listed_asins WHERE ended_at IS NULL
  ORDER BY LENGTH(title) DESC LIMIT 10
`)
console.log('\nLongest 10 active titles:')
for (const r of longTitles) console.log(`  [${r.len}] ${r.title}`)

// 3. Sample of short titles
const shortTitles = await sql(`
  SELECT user_id, asin, title, LENGTH(title) AS len
  FROM listed_asins WHERE ended_at IS NULL AND LENGTH(title) > 0
  ORDER BY LENGTH(title) ASC LIMIT 10
`)
console.log('\nShortest 10 active titles:')
for (const r of shortTitles) console.log(`  [${r.len}] ${r.title}`)

// 4. Titles ending in cut-off looking patterns
const midwordCutoff = await sql(`
  SELECT user_id, asin, title
  FROM listed_asins WHERE ended_at IS NULL
    AND LENGTH(title) >= 78
    AND (title ~ '[a-z]$' AND title !~ ' [a-z]+$')
  LIMIT 8
`)
console.log('\nPossibly mid-word-truncated (max-length, ends mid-token):')
for (const r of midwordCutoff) console.log(`  ${r.title}`)

console.log('\n\n========== SOURCE POOL QUALITY ==========\n')

// 5. Source quality distribution
const sqDist = await sql(`
  SELECT COALESCE(source_quality, 'unset') AS q, COUNT(*)::int AS n
  FROM product_source_items WHERE active = TRUE
  GROUP BY 1 ORDER BY 2 DESC
`)
console.log('Source quality distribution:')
console.log(JSON.stringify(sqDist, null, 2))

// 6. Master score distribution (the "is this product the best" signal)
const scoreDist = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE master_score >= 80)::int AS tier_a_80_plus,
    COUNT(*) FILTER (WHERE master_score >= 65 AND master_score < 80)::int AS tier_b_65_79,
    COUNT(*) FILTER (WHERE master_score >= 50 AND master_score < 65)::int AS tier_c_50_64,
    COUNT(*) FILTER (WHERE master_score >= 38 AND master_score < 50)::int AS tier_d_38_49,
    COUNT(*) FILTER (WHERE master_score IS NULL OR master_score < 38)::int AS below_floor,
    ROUND(AVG(master_score), 2) AS avg_score
  FROM product_source_items WHERE active = TRUE
`)
console.log('Master score distribution (38 = MIN, ≥65 = strong):')
console.log(JSON.stringify(scoreDist[0], null, 2))

// 7. Top 10 highest-scoring products in pool (the "absolute best")
const topProducts = await sql(`
  SELECT asin, source_niche, ROUND(master_score, 1) AS score, ROUND(profit, 2) AS profit,
         ROUND(roi, 1) AS roi, rating, review_count, LEFT(title, 70) AS title_preview
  FROM product_source_items
  WHERE active = TRUE AND master_score IS NOT NULL
  ORDER BY master_score DESC LIMIT 10
`)
console.log('\nTop 10 products in pool by masterScore:')
for (const r of topProducts) console.log(`  [${r.score} | $${r.profit} | ${r.roi}% ROI] ${r.source_niche} — ${r.title_preview}`)
