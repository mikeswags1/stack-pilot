// Efficiency report — credits per workflow, credits per successful listing,
// paid-call yield, retry timing, rejection reasons. Read-only.
// Run: node scripts/efficiency-report.mjs [hours=24]
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const sql = neon(env.DATABASE_URL)
const HOURS = Math.max(1, Math.min(720, Number(process.argv[2] || '24')))
const CREDITS_PER_CALL = 5 // ScraperAPI structured Amazon endpoints

const paid = await sql(`
  SELECT call_name,
         COUNT(*)::int AS calls,
         COUNT(*) FILTER (WHERE success)::int AS ok,
         COUNT(*) FILTER (WHERE error_code = 'reserved')::int AS unsettled
  FROM api_usage_log
  WHERE provider = 'scraperapi' AND created_at > NOW() - ($1 || ' hours')::interval
  GROUP BY 1 ORDER BY 2 DESC
`, [HOURS])

const listings = await sql(`
  SELECT COUNT(*)::int AS n FROM auto_listing_queue
  WHERE status = 'completed' AND listed_at > NOW() - ($1 || ' hours')::interval
`, [HOURS])

const failures = await sql(`
  SELECT error_code, COUNT(*)::int AS n
  FROM listing_failure_log
  WHERE created_at > NOW() - ($1 || ' hours')::interval
  GROUP BY 1 ORDER BY 2 DESC LIMIT 12
`, [HOURS])

const queueFailures = await sql(`
  SELECT LEFT(COALESCE(last_error,'?'), 55) AS reason, COUNT(*)::int AS n
  FROM auto_listing_queue
  WHERE status = 'failed' AND updated_at > NOW() - ($1 || ' hours')::interval
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10
`, [HOURS])

// Retry discipline: attempts on retry rows must not fire before scheduled_at.
const retryTiming = await sql(`
  SELECT COUNT(*)::int AS retried_early
  FROM auto_listing_queue
  WHERE status = 'processing' AND attempts > 1
    AND scheduled_at IS NOT NULL AND updated_at < scheduled_at
`)

const verifier = await sql(`
  SELECT
    COUNT(*) FILTER (WHERE amazon_status_reason = 'check_failed' AND amazon_status_checked_at > NOW() - ($1 || ' hours')::interval)::int AS check_failed,
    COUNT(*) FILTER (WHERE amazon_price_verified_at > NOW() - ($1 || ' hours')::interval)::int AS verified,
    COUNT(*) FILTER (WHERE ended_at IS NULL AND ebay_listing_id <> '')::int AS active_total,
    COUNT(*) FILTER (WHERE ended_at IS NULL AND ebay_listing_id <> '' AND amazon_price_verified_at > NOW() - INTERVAL '7 days')::int AS verified_7d
  FROM listed_asins
`, [HOURS])

const overlaps = await sql(`
  SELECT mode, COUNT(*)::int AS runs
  FROM source_engine_runs
  WHERE started_at > NOW() - ($1 || ' hours')::interval
  GROUP BY 1 ORDER BY 2 DESC
`, [HOURS]).catch(() => [])

// Attributed paid verifications: every paid listing-check with its final outcome.
const attribution = await sql(`
  SELECT outcome, COUNT(*)::int AS n
  FROM paid_verification_log
  WHERE created_at > NOW() - ($1 || ' hours')::interval
  GROUP BY 1 ORDER BY 2 DESC
`, [HOURS]).catch(() => [])

const account = await fetch(`https://api.scraperapi.com/account?api_key=${env.SCRAPERAPI_KEY}`, { signal: AbortSignal.timeout(15000) })
  .then(r => r.json()).catch(() => null)

const totalCalls = paid.reduce((a, r) => a + r.calls, 0)
const listed = listings[0]?.n || 0
console.log(`\n===== EFFICIENCY REPORT (last ${HOURS}h) =====`)
console.log(`\nPaid ScraperAPI calls by workflow (tracked):`)
for (const r of paid) console.log(`  ${r.call_name.padEnd(28)} ${String(r.calls).padStart(5)} calls  (${r.ok} ok, ${r.unsettled} unsettled) ≈ ${r.calls * CREDITS_PER_CALL} credits`)
console.log(`  TOTAL ${totalCalls} calls ≈ ${totalCalls * CREDITS_PER_CALL} credits`)
if (account) console.log(`  Account: ${account.creditsLeft} credits left this cycle (resets ${String(account.nextBillingDate).slice(0, 10)})`)
console.log(`\nListings completed: ${listed}`)
console.log(`Credits per successful listing: ${listed > 0 ? Math.round(totalCalls * CREDITS_PER_CALL / listed) : 'n/a (0 listings)'}`)
console.log(`\nFree verifier (${HOURS}h): ${verifier[0].verified} verified vs ${verifier[0].check_failed} check_failed`)
console.log(`Store coverage: ${verifier[0].verified_7d}/${verifier[0].active_total} active listings price-verified within 7 days`)
console.log(`\nRetry rows fired before their scheduled_at: ${retryTiming[0].retried_early}`)
console.log(`\nListing rejection reasons:`)
for (const r of failures) console.log(`  ${String(r.n).padStart(5)}  ${r.error_code}`)
console.log(`\nQueue terminal failures:`)
for (const r of queueFailures) console.log(`  ${String(r.n).padStart(5)}  ${r.reason}`)
if (overlaps.length) {
  console.log(`\nsource-engine runs by mode:`)
  for (const r of overlaps) console.log(`  ${String(r.runs).padStart(5)}  ${r.mode}`)
}
if (attribution.length) {
  const attributedListed = attribution.find(r => r.outcome === 'listed')?.n || 0
  const attributedTotal = attribution.reduce((a, r) => a + r.n, 0)
  console.log(`\nPaid verification attribution (${attributedTotal} paid checks):`)
  for (const r of attribution) console.log(`  ${String(r.n).padStart(5)}  ${r.outcome}`)
  console.log(`  Attributed credits per listed: ${attributedListed > 0 ? Math.round(attributedTotal * CREDITS_PER_CALL / attributedListed) : 'n/a'}`)
}
