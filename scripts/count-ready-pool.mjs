// One-off diagnostic: how many genuinely list-ready products are in the pool?
// Mirrors the core gates from loadProductSourceProducts so we know whether the
// dashboard CAN reach 30 ready, or whether Mike has already listed most of them.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

const totalActive = await sql`SELECT COUNT(*)::int n FROM product_source_items WHERE active = TRUE`
const notListed = await sql`
  SELECT COUNT(*)::int n FROM product_source_items psi
  WHERE psi.active = TRUE
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
`
const passGates = await sql`
  SELECT COUNT(*)::int n
  FROM product_source_items psi
  LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(psi.asin)
  WHERE psi.active = TRUE
    AND psi.profit >= 4 AND psi.roi >= 25 AND psi.risk <> 'HIGH'
    AND psi.image_url IS NOT NULL AND psi.image_url <> ''
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND COALESCE(apc.available, TRUE) <> FALSE
    AND apc.asin IS NOT NULL
    AND jsonb_typeof(apc.images) = 'array'
    AND jsonb_array_length(apc.images) >= 2
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE UPPER(la.asin) = UPPER(psi.asin) AND la.ended_at IS NULL)
`
const totalListed = await sql`SELECT COUNT(*)::int n FROM listed_asins WHERE ended_at IS NULL`

console.log('=== POOL DIAGNOSTIC ===')
console.log(`Active source items:                 ${totalActive[0].n}`)
console.log(`Active + not currently listed:       ${notListed[0].n}`)
console.log(`FULLY list-ready (passes all gates): ${passGates[0].n}`)
console.log(`Currently live eBay listings:        ${totalListed[0].n}`)
console.log('')
console.log(passGates[0].n >= 30
  ? `✅ Pool HAS ${passGates[0].n} ready — 30 is achievable. The frontend 30-gate is the only blocker.`
  : `⚠️ Pool has only ${passGates[0].n} ready — under 30. Forcing a 30-minimum permanently locks the button.`)
