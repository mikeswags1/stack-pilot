// Settle the one-strike OOS suspects: one verified ScraperAPI read each.
// Explicit OOS -> second confirmation (purge-eligible). Explicit in-stock -> flag
// cleared + price refreshed. Ambiguous -> untouched. Spend is reserved atomically
// against the structured-product DAILY counter (supervised one-off: hourly pacing
// intentionally not applied) and logged to api_usage_log. Receipts written.
// Run: node scripts/recheck-suspects.mjs --apply   (default = preview count only)
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'
const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const sql = neon(env.DATABASE_URL)
const APPLY = process.argv.includes('--apply')
const DAILY_CAP = 400

const rows = await sql(`
  SELECT user_id, ebay_listing_id, asin, title, ebay_price::float AS ebay_price
  FROM listed_asins
  WHERE ended_at IS NULL AND ebay_listing_id <> ''
    AND amazon_available = FALSE
    AND amazon_status_reason IN ('unavailable','out_of_stock')
    AND amazon_unavailable_confirmed_count = 1
  ORDER BY amazon_unavailable_last_seen_at ASC
`)
console.log(`${rows.length} one-strike suspects ${APPLY ? 'to verify' : '(PREVIEW — rerun with --apply)'}`)
if (!APPLY) process.exit(0)

async function reserveSlot() {
  const r = await sql(`
    INSERT INTO quota_counters (provider, call_name, day_key, hour_key, day_count, hour_count)
    VALUES ('scraperapi', 'structured-product', (NOW() AT TIME ZONE 'America/Los_Angeles')::date::text, to_char(NOW(), 'YYYY-MM-DD-HH24'), 1, 1)
    ON CONFLICT (provider, call_name, day_key) DO UPDATE SET
      day_count = quota_counters.day_count + 1,
      hour_count = CASE WHEN quota_counters.hour_key = EXCLUDED.hour_key THEN quota_counters.hour_count + 1 ELSE 1 END,
      hour_key = EXCLUDED.hour_key, updated_at = NOW()
    WHERE quota_counters.day_count < $1
    RETURNING day_count
  `, [DAILY_CAP])
  if (r.length === 0) return false
  await sql(`INSERT INTO api_usage_log (provider, call_name, success, error_code) VALUES ('scraperapi','structured-product',TRUE,'suspect-sweep')`).catch(() => {})
  return true
}

const parsePrice = (s) => { const m = String(s || '').match(/([\d,]+\.\d{2})/); return m ? parseFloat(m[1].replace(/,/g, '')) : null }
let healed = 0, condemned = 0, ambiguous = 0, stopped = null
const receipts = []
for (const r of rows) {
  if (!(await reserveSlot())) { stopped = 'daily cap reached — rerun after midnight Pacific for the rest'; break }
  const res = await fetch(`https://api.scraperapi.com/structured/amazon/product?api_key=${env.SCRAPERAPI_KEY}&asin=${r.asin}&country=us`, { signal: AbortSignal.timeout(45000) }).catch(() => null)
  if (res && [401, 403, 429].includes(res.status)) { stopped = 'credits exhausted / rate limited'; break }
  const d = res && res.status === 200 ? await res.json().catch(() => null) : null
  const avail = String(d?.availability_status || '').trim()
  const price = parsePrice(d?.pricing)
  const explicitOOS = /unavailable|out of stock|temporarily out/i.test(avail)
  const explicitInStock = /in stock|left in stock/i.test(avail) && !explicitOOS
  if (explicitOOS) {
    condemned++
    await sql(`
      UPDATE listed_asins SET amazon_unavailable_confirmed_count = 2, amazon_unavailable_last_seen_at = NOW(),
        amazon_status_checked_at = NOW()
      WHERE ebay_listing_id = $1 AND ended_at IS NULL
    `, [r.ebay_listing_id])
    receipts.push({ at: new Date().toISOString(), verdict: 'confirmed_dead', ...r })
  } else if (explicitInStock) {
    healed++
    await sql(`
      UPDATE listed_asins SET amazon_available = TRUE, amazon_status_reason = 'available',
        amazon_status_checked_at = NOW(), amazon_unavailable_confirmed_count = 0,
        amazon_unavailable_first_seen_at = NULL, amazon_unavailable_last_seen_at = NULL,
        amazon_price = COALESCE($2, amazon_price), amazon_verified_price = COALESCE($2, amazon_verified_price),
        amazon_price_verified_at = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE amazon_price_verified_at END,
        amazon_price_verification_source = CASE WHEN $2 IS NOT NULL THEN 'amazon_buy_box' ELSE amazon_price_verification_source END
      WHERE ebay_listing_id = $1 AND ended_at IS NULL
    `, [r.ebay_listing_id, explicitInStock ? price : null])
    receipts.push({ at: new Date().toISOString(), verdict: 'healed_in_stock', price, ...r })
  } else {
    ambiguous++
  }
  if ((healed + condemned + ambiguous) % 50 === 0) console.log(`  ...${healed + condemned + ambiguous}/${rows.length} (${healed} healed, ${condemned} condemned, ${ambiguous} ambiguous)`)
  await new Promise((x) => setTimeout(x, 400))
}
fs.mkdirSync(path.resolve('scripts/receipts'), { recursive: true })
if (receipts.length) fs.appendFileSync(path.resolve('scripts/receipts/suspect-sweep.jsonl'), receipts.map((x) => JSON.stringify(x)).join('\n') + '\n')
console.log(`\nDONE: ${healed} healed, ${condemned} condemned (now purge-eligible), ${ambiguous} ambiguous of ${rows.length}${stopped ? ` — STOPPED EARLY: ${stopped}` : ''}`)
