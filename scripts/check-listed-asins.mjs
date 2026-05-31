import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)

const overall = await sql(`
  SELECT
    COUNT(*)::int total_rows,
    COUNT(*) FILTER (WHERE ended_at IS NULL)::int active,
    COUNT(*) FILTER (WHERE ended_at IS NOT NULL)::int ended,
    COUNT(*) FILTER (WHERE ended_at > NOW() - INTERVAL '1 hour')::int ended_last_hour,
    COUNT(*) FILTER (WHERE ended_at > NOW() - INTERVAL '12 hours')::int ended_last_12h
  FROM listed_asins`)
console.log('listed_asins overall:', JSON.stringify(overall[0], null, 2))

const recentEnds = await sql(`
  SELECT DATE_TRUNC('hour', ended_at) AS hr, COUNT(*)::int n
  FROM listed_asins
  WHERE ended_at > NOW() - INTERVAL '24 hours'
  GROUP BY hr ORDER BY hr DESC LIMIT 12`)
console.log('\nListings marked ended_at, by hour (last 24h):')
for (const r of recentEnds) console.log(`  ${new Date(r.hr).toISOString().slice(0,16)}  ${r.n}`)

const sampleEnded = await sql(`
  SELECT ebay_listing_id, LEFT(title, 50) title, listed_at, ended_at, amazon_status_reason
  FROM listed_asins
  WHERE ended_at > NOW() - INTERVAL '12 hours'
  ORDER BY ended_at DESC LIMIT 8`)
console.log('\nSample of recently-ended:')
for (const r of sampleEnded) console.log(`  ${r.ebay_listing_id} | ended ${new Date(r.ended_at).toISOString().slice(11,19)} | reason: ${r.amazon_status_reason || '(none)'} | ${r.title}`)
