// Post-mortem analysis from the backup file + DB. No eBay calls needed.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

// 1) When did the bug first start firing — distribution of ended_at over time
const timeline = await sql(`
  SELECT DATE_TRUNC('day', ended_at) AS day,
         COUNT(*)::int n,
         COUNT(DISTINCT amazon_status_reason) AS distinct_reasons
  FROM listed_asins
  WHERE ended_at IS NOT NULL AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''
  GROUP BY day ORDER BY day`)
console.log('1. TIMELINE — when listings got marked ended (by day)')
console.log('   ' + 'date'.padEnd(12) + 'count   reasons')
for (const r of timeline) {
  console.log(`   ${new Date(r.day).toISOString().slice(0,10)}  ${String(r.n).padStart(5)}   ${r.distinct_reasons}`)
}

const firstEnd = await sql(`
  SELECT MIN(ended_at) AS first_end, MAX(ended_at) AS last_end
  FROM listed_asins
  WHERE ended_at IS NOT NULL AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''`)
console.log(`\n   First ended_at: ${firstEnd[0].first_end}`)
console.log(`   Last ended_at:  ${firstEnd[0].last_end}`)

// Hourly distribution for the worst day (to identify single-cron-burst events)
const worstHour = await sql(`
  WITH worst AS (
    SELECT DATE_TRUNC('day', ended_at) AS day, COUNT(*) AS n
    FROM listed_asins WHERE ended_at IS NOT NULL AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''
    GROUP BY day ORDER BY n DESC LIMIT 1
  )
  SELECT DATE_TRUNC('hour', ended_at) AS hr, COUNT(*)::int n
  FROM listed_asins, worst
  WHERE listed_asins.ended_at IS NOT NULL AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''
    AND DATE_TRUNC('day', listed_asins.ended_at) = worst.day
  GROUP BY hr ORDER BY hr`)
console.log('\n   Hourly breakdown of the worst day:')
for (const r of worstHour) console.log(`     ${new Date(r.hr).toISOString().slice(11,16)} UTC  ${r.n}`)

// 2) How many were incorrectly ended
console.log('\n2. SCALE OF DAMAGE')
const damage = await sql(`
  SELECT COUNT(*)::int total
  FROM listed_asins
  WHERE ended_at IS NOT NULL AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''`)
console.log(`   Total rows in backup:                 ${damage[0].total}`)
console.log(`   (Of these, eBay-confirmed-active will be restored at 3am ET)`)
console.log(`   (The rest are genuinely ended — sold, removed, Amazon-unavailable)`)

// Reason breakdown
const reasons = await sql(`
  SELECT COALESCE(amazon_status_reason,'(none)') reason, COUNT(*)::int n
  FROM listed_asins
  WHERE ended_at IS NOT NULL AND ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''
  GROUP BY 1 ORDER BY 2 DESC`)
console.log('\n   Status reason on ended rows (clue to which code path ended them):')
for (const r of reasons) console.log(`     ${String(r.reason).padEnd(40)} ${r.n}`)
