// Diagnostic: are there any duplicate ACTIVE listings (same ASIN listed twice)?
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

const dupes = await sql`
  SELECT UPPER(asin) AS asin, COUNT(*)::int AS n
  FROM listed_asins
  WHERE ended_at IS NULL AND asin IS NOT NULL
  GROUP BY UPPER(asin)
  HAVING COUNT(*) > 1
  ORDER BY n DESC
  LIMIT 20
`
const totalActive = await sql`SELECT COUNT(*)::int n FROM listed_asins WHERE ended_at IS NULL`
const distinctActive = await sql`SELECT COUNT(DISTINCT UPPER(asin))::int n FROM listed_asins WHERE ended_at IS NULL AND asin IS NOT NULL`

console.log('=== DUPLICATE ACTIVE LISTINGS CHECK ===')
console.log(`Total active listings:        ${totalActive[0].n}`)
console.log(`Distinct products (ASINs):    ${distinctActive[0].n}`)
console.log(`ASINs listed more than once:  ${dupes.length}`)
if (dupes.length === 0) {
  console.log('\n✅ ZERO duplicate listings. Every active listing is a unique product.')
} else {
  console.log('\n⚠️ Found duplicates:')
  for (const d of dupes) console.log(`   ${d.asin}: listed ${d.n} times`)
}
