// Verify Anthropic provider is being used now that key is set
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] })
)
const sql = neon(env.DATABASE_URL)

const recentRuns = await sql(`
  SELECT provider, status, created_at::text AS at, duration_ms,
         plan->'newNiches' AS new_niches_proposed,
         plan->'repairNiches' AS repair_niches,
         LEFT(COALESCE(error, ''), 200) AS error_preview
  FROM source_agent_runs
  WHERE created_at > NOW() - INTERVAL '3 hours'
  ORDER BY created_at DESC LIMIT 5
`)
console.log('Recent source agent runs (last 3 hours):')
for (const r of recentRuns) {
  console.log(`  ${r.at} | provider=${r.provider} | status=${r.status} | ${r.duration_ms}ms`)
  if (r.new_niches_proposed && Array.isArray(r.new_niches_proposed)) {
    console.log(`    new niches proposed: ${r.new_niches_proposed.length}`)
  }
  if (r.error_preview) console.log(`    error: ${r.error_preview}`)
}
if (recentRuns.length === 0) console.log('  (no runs in last 3 hours — next cron tick at minute :23)')
