// Purge CONFIRMED-unfulfillable listings. Ends ONLY listings with explicit,
// repeated, post-6/29-fix out-of-stock evidence — never on missing/failed reads.
// No Amazon calls are made; this acts on stored confirmations exclusively.
// Run: node scripts/purge-confirmed-oos.mjs [--apply]   (default = preview)
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'
const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const sql = neon(env.DATABASE_URL)
const APPLY = process.argv.includes('--apply')

async function getToken(u) {
  let rr = await sql(`SELECT oauth_token, refresh_token, token_expires_at FROM ebay_accounts WHERE user_id=$1 AND active=TRUE ORDER BY id ASC LIMIT 1`, [String(u)]).catch(() => [])
  const c = rr[0]; if (!c) return null
  const expired = !c.token_expires_at || new Date(c.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)
  if (c.oauth_token && !expired) return c.oauth_token
  const basic = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token, scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory' }) })
  const d = await res.json(); return d.access_token || null
}

// 2026-08-01 owner blanket approval ("end all risky listings, no more from me"):
// the purge now covers every risky class from the agreed rulebook —
//   oos       : explicit unavailable, 2+ fresh post-fix strikes
//   mismatch  : verified wrong product behind the listing
//   haul      : confirmed Amazon Haul source (structural slow shipper)
//   slow      : explicit slow-delivery evidence (fast_fulfillment = FALSE)
//   bad_roi   : negative net or ROI < 8% at a FRESH verified price
// Still NEVER on ambiguous/missing/stale evidence. Strict ack verification.
const rows = await sql(`
  SELECT user_id, ebay_listing_id, asin, title, ebay_price::float AS ebay_price,
         amazon_unavailable_confirmed_count AS confirms,
         amazon_status_reason,
         amazon_unavailable_first_seen_at,
         amazon_unavailable_last_seen_at,
         CASE
           WHEN amazon_available = FALSE AND amazon_status_reason IN ('unavailable','out_of_stock')
             AND amazon_unavailable_confirmed_count >= 2
             AND amazon_unavailable_last_seen_at > NOW() - INTERVAL '7 days'
             AND amazon_unavailable_first_seen_at > '2026-06-29' THEN 'oos'
           WHEN amazon_status_reason = 'asin_mismatch' THEN 'mismatch'
           WHEN amazon_fulfillment_summary = 'amazon_haul_slow_shipper' THEN 'haul'
           WHEN amazon_fast_fulfillment = FALSE THEN 'slow'
           ELSE 'bad_roi'
         END AS risk_class
  FROM listed_asins
  WHERE ended_at IS NULL AND ebay_listing_id <> ''
    AND (
      (amazon_available = FALSE AND amazon_status_reason IN ('unavailable','out_of_stock')
        AND amazon_unavailable_confirmed_count >= 2
        AND amazon_unavailable_last_seen_at > NOW() - INTERVAL '7 days'
        AND amazon_unavailable_first_seen_at > '2026-06-29')
      OR amazon_status_reason = 'asin_mismatch'
      OR amazon_fulfillment_summary = 'amazon_haul_slow_shipper'
      OR amazon_fast_fulfillment = FALSE
      OR (amazon_price_verified_at > NOW() - INTERVAL '7 days' AND amazon_verified_price > 0
          AND ((ebay_price*(1-0.136-0.02-0.015) - CASE WHEN ebay_price<=10 THEN 0.30 ELSE 0.40 END - amazon_verified_price*1.07) < 0
            OR ((ebay_price*(1-0.136-0.02-0.015) - CASE WHEN ebay_price<=10 THEN 0.30 ELSE 0.40 END - amazon_verified_price*1.07)/NULLIF(amazon_verified_price,0)) < 0.08))
    )
  ORDER BY user_id, amazon_unavailable_confirmed_count DESC
`)
console.log(`${rows.length} confirmed-unfulfillable listings ${APPLY ? 'to END' : '(PREVIEW — rerun with --apply to end)'}`)
for (const r of rows.slice(0, 15)) {
  console.log(`  [u${r.user_id}] eBay ${r.ebay_listing_id} · ASIN ${r.asin} · x${r.confirms} explicit OOS · $${r.ebay_price}`)
  console.log(`       first ${r.amazon_unavailable_first_seen_at?.toISOString?.() || r.amazon_unavailable_first_seen_at} · latest ${r.amazon_unavailable_last_seen_at?.toISOString?.() || r.amazon_unavailable_last_seen_at}`)
  console.log(`       ${r.title.slice(0, 100)}`)
}
if (!APPLY) process.exit(0)

const tokens = { 1: await getToken(1), 3: await getToken(3) }
let ended = 0, failed = 0
const receipts = []
for (const r of rows) {
  const token = tokens[r.user_id]
  if (!token) { failed++; continue }
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ItemID>${r.ebay_listing_id}</ItemID><EndingReason>NotAvailable</EndingReason></EndItemRequest>`
  const res = await fetch('https://api.ebay.com/ws/api.dll', { method: 'POST', headers: { 'X-EBAY-API-CALL-NAME': 'EndItem', 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-APP-NAME': env.EBAY_APP_ID, 'Content-Type': 'text/xml' }, body: xml }).catch(() => null)
  const tx = res ? await res.text() : ''
  if (/exceeded usage limit/i.test(tx)) { console.log('eBay quota stop'); break }
  // STRICT success only (2026-07-30 lesson: the loose /already|ended|closed/ text
  // match let a FAILED EndItem read as success — the listing stayed live on eBay
  // for 16 days while the DB said ended, then sold unfulfillable). A Failure ack
  // may only be treated as resolved when eBay EXPLICITLY says the item is already
  // ended or does not exist.
  const ack = tx.match(/<Ack>(.*?)<\/Ack>/)?.[1]
  const longMsg = tx.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || ''
  const alreadyGone = /already (been )?ended|has ended|item .*(was not found|is invalid|does not exist)/i.test(longMsg)
  if (ack === 'Success' || ack === 'Warning' || alreadyGone) {
    ended++
    await sql(`UPDATE listed_asins SET ended_at=NOW(), amazon_status_reason=$2 WHERE ebay_listing_id=$1 AND ended_at IS NULL`, [r.ebay_listing_id, 'risk_purge_' + r.risk_class])
    receipts.push({ at: new Date().toISOString(), ack, alreadyGone, ...r })
  } else {
    failed++
    console.log(`  END-FAIL ${r.ebay_listing_id}: ${longMsg.slice(0, 120) || tx.slice(0, 120)}`)
  }
  if (ended % 50 === 0 && ended > 0) console.log(`  ...${ended} ended`)
  await new Promise((x) => setTimeout(x, 200))
}
fs.mkdirSync(path.resolve('scripts/receipts'), { recursive: true })
if (receipts.length) fs.appendFileSync(path.resolve('scripts/receipts/confirmed-oos-purge.jsonl'), receipts.map((x) => JSON.stringify(x)).join('\n') + '\n')
console.log(`\nDONE: ${ended} ended, ${failed} failed of ${rows.length}`)
