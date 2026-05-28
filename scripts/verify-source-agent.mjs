// Verify source agent is functioning and audit what's actually been happening
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

console.log('==== SOURCE AGENT RECENT RUNS ====\n')
const runs = await sql(`
  SELECT provider, status, created_at::text AS at, duration_ms,
         jsonb_array_length(COALESCE(plan->'newNiches', '[]'::jsonb)) AS proposed_new,
         jsonb_array_length(COALESCE(plan->'repairNiches', '[]'::jsonb)) AS proposed_repair,
         LEFT(COALESCE(error, ''), 120) AS error
  FROM source_agent_runs WHERE created_at > NOW() - INTERVAL '24 hours'
  ORDER BY created_at DESC LIMIT 12
`)
for (const r of runs) {
  console.log(`  ${r.at.slice(0, 16)} | ${r.provider.padEnd(13)} | ${r.status.padEnd(8)} | ${r.duration_ms}ms | propose:${r.proposed_new}new/${r.proposed_repair}repair${r.error ? ' | ' + r.error : ''}`)
}

console.log('\n==== POOL GROWTH (last 30 days) ====\n')
const growth = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '24 hours')::int AS today,
    COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '7 days')::int AS week,
    COUNT(*) FILTER (WHERE first_seen_at > NOW() - INTERVAL '30 days')::int AS month,
    COUNT(*)::int AS total
  FROM product_source_items
`)
console.log(JSON.stringify(growth[0], null, 2))

console.log('\n==== HOW POOL ROWS GOT THEIR DATA (from raw.source_provider) ====\n')
const providers = await sql(`
  SELECT
    COALESCE(raw->>'sourceProvider', '(none)') AS provider,
    COUNT(*)::int AS n
  FROM product_source_items
  WHERE active = TRUE
  GROUP BY 1 ORDER BY 2 DESC
`)
for (const r of providers) console.log(`  ${r.provider.padEnd(20)} ${r.n}`)

console.log('\n==== AMAZON CACHE COVERAGE ====\n')
const cache = await sql(`
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE jsonb_typeof(images) = 'array' AND jsonb_array_length(images) >= 2)::int AS with_2_plus_images,
    COUNT(*) FILTER (WHERE jsonb_typeof(images) = 'array' AND jsonb_array_length(images) >= 4)::int AS with_4_plus_images,
    COUNT(*) FILTER (WHERE description IS NULL OR description = '')::int AS no_description
  FROM amazon_product_cache
`)
console.log(JSON.stringify(cache[0], null, 2))
