// Cost report — tracks ScraperAPI credit burn + Neon usage proxies so we can spot
// waste and project month-end. Run anytime: node scripts/cost-report.mjs
// Appends a snapshot to scripts/receipts/cost-log.jsonl so trends accumulate.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)

// ── ScraperAPI (exact, from their account endpoint) ──────────────────────────
const acct = await (await fetch(`https://api.scraperapi.com/account?api_key=${env.SCRAPERAPI_KEY}`, { signal: AbortSignal.timeout(20000) })).json()
const cycleStart = new Date(acct.lastBillingDate)
const cycleEnd = new Date(acct.nextBillingDate)
const daysIn = Math.max((Date.now() - cycleStart) / 86400000, 0.25)
const daysTotal = (cycleEnd - cycleStart) / 86400000
const burnPerDay = acct.requestCount / daysIn
const projected = Math.round(burnPerDay * daysTotal)
console.log('══ ScraperAPI ($49/mo, 100k credits) ══')
console.log(`  used: ${acct.requestCount.toLocaleString()} / ${acct.requestLimit.toLocaleString()}  (${(acct.requestCount/acct.requestLimit*100).toFixed(1)}%)`)
console.log(`  left: ${acct.creditsLeft.toLocaleString()}  | day ${Math.ceil(daysIn)} of ${Math.round(daysTotal)} | resets ${cycleEnd.toISOString().slice(0,10)}`)
console.log(`  current pace projects: ${projected.toLocaleString()} by month end ${projected > acct.requestLimit ? '⚠ OVER — will pause (never overbills)' : '✓ within plan'}`)

// App-side burn by caller (each request ≈ 5 credits)
const burn = await sql(`
  SELECT call_name, COUNT(*)::int calls,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int last24h
  FROM api_usage_log WHERE provider='scraperapi' GROUP BY 1 ORDER BY 2 DESC`).catch(()=>[])
if (burn.length){
  console.log('  app-side callers (requests, ~5 credits each):')
  for(const r of burn) console.log(`    ${r.call_name}: ${r.calls} total, ${r.last24h} last 24h`)
  const scriptSide = acct.requestCount - burn.reduce((s,r)=>s+r.calls,0)*5
  if (scriptSide > 500) console.log(`    (standalone scripts / audits: ~${scriptSide.toLocaleString()} credits)`)
}

// ── Neon (proxies: size, table bloat, activity spread) ───────────────────────
console.log('\n══ Neon Postgres ══')
const size = await sql(`SELECT pg_size_pretty(pg_database_size(current_database())) s, pg_database_size(current_database())::bigint b`)
console.log(`  database size: ${size[0].s}`)
const topTables = await sql(`
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) sz, pg_total_relation_size(relid)::bigint b
  FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5`)
console.log('  biggest tables:')
for(const t of topTables) console.log(`    ${t.relname}: ${t.sz}`)
// Activity spread = how many hours/day the DB is being woken (compute cost driver)
const act = await sql(`
  SELECT COUNT(DISTINCT date_trunc('hour', created_at))::int active_hours
  FROM api_usage_log WHERE created_at > NOW() - INTERVAL '24 hours'`).catch(()=>[{active_hours:null}])
console.log(`  active hours (last 24h, via logged API calls): ${act[0].active_hours ?? 'n/a'} / 24`)
console.log('  (compute bill ≈ hours awake × CU cap — crons every 30min keep it awake ~24/7; CU capped at 1)')

// ── snapshot for trends ──────────────────────────────────────────────────────
const snap = {
  at: new Date().toISOString(),
  scraperapi: { used: acct.requestCount, left: acct.creditsLeft, projected },
  neon: { db_bytes: Number(size[0].b), active_hours_24h: act[0].active_hours },
}
const logPath = path.resolve(process.cwd(), 'scripts/receipts/cost-log.jsonl')
fs.appendFileSync(logPath, JSON.stringify(snap) + '\n')
const hist = fs.readFileSync(logPath,'utf-8').trim().split('\n').map(l=>JSON.parse(l))
if (hist.length > 1){
  const prev = hist[hist.length-2]
  const dCred = snap.scraperapi.used - prev.scraperapi.used
  const dDays = Math.max((new Date(snap.at) - new Date(prev.at)) / 86400000, 0.01)
  console.log(`\n  since last check (${dDays.toFixed(1)}d ago): +${dCred.toLocaleString()} credits (${Math.round(dCred/dDays).toLocaleString()}/day)`)
}
