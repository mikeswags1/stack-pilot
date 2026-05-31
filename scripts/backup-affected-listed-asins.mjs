// Full row dump of every listed_asins row that is a CANDIDATE for restoration:
// has an eBay listing ID and is currently marked ended. Written to a timestamped
// JSON so restore is fully reversible (we can replay ended_at back from the file).
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

const rows = await sql(`
  SELECT *
  FROM listed_asins
  WHERE ebay_listing_id IS NOT NULL
    AND ebay_listing_id <> ''
    AND ended_at IS NOT NULL
  ORDER BY id
`)

fs.mkdirSync('scripts/backups', { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const file = `scripts/backups/listed-asins-pre-restore-${ts}.json`
fs.writeFileSync(file, JSON.stringify({
  backed_up_at: new Date().toISOString(),
  description: 'Full snapshot of listed_asins rows with ebay_listing_id and ended_at NOT NULL, prior to data-integrity restore on 2026-05-30.',
  row_count: rows.length,
  rows,
}, null, 2))

console.log(`Backed up ${rows.length} rows to ${file}`)
console.log(`File size: ${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB`)

// Quick distribution summary so the user knows what's in the backup
const byReason = await sql(`
  SELECT COALESCE(amazon_status_reason, '(none)') AS reason, COUNT(*)::int n
  FROM listed_asins
  WHERE ebay_listing_id IS NOT NULL AND ebay_listing_id <> '' AND ended_at IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
`)
console.log('\nBackup breakdown by status reason:')
for (const r of byReason) console.log(`  ${String(r.reason).padEnd(40)} ${r.n}`)
