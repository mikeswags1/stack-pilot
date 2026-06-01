// Reprice the next 100 overpriced listings — skip ones already in
// pricing_audit_log so we don't re-touch the original 20. Same infrastructure
// (audit log, per-listing receipts, kill switch). Pace at 1.5s per call.

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const APPLY = process.argv.includes('--apply')
if (process.env.PRICING_KILL_SWITCH === '1') { console.error('Kill switch on'); process.exit(1) }

const sql = neon(env.DATABASE_URL)
const cred = await sql(`SELECT oauth_token, token_expires_at FROM ebay_credentials WHERE user_id = 1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`)
if (!cred[0]) { console.error('No eBay credentials'); process.exit(1) }
const token = cred[0].oauth_token
if (new Date(cred[0].token_expires_at) < new Date()) { console.error('Token expired'); process.exit(1) }

// Already-repriced listings (skip)
const prior = await sql(`SELECT DISTINCT ebay_listing_id FROM pricing_audit_log WHERE applied = TRUE`)
const skipSet = new Set(prior.map((p) => p.ebay_listing_id))
console.log(`Already-repriced (will skip): ${skipSet.size}`)

const proposalsDir = 'scripts/proposals'
const files = fs.readdirSync(proposalsDir).filter((f) => f.startsWith('dynamic-pricing-proposal-')).sort().reverse()
const latest = JSON.parse(fs.readFileSync(path.join(proposalsDir, files[0]), 'utf-8'))

const candidates = latest.proposals
  .filter((p) => p.outcome === 'REPRICE_DOWN' && !skipSet.has(p.ebay_listing_id))
  .map((p) => ({ ...p, ratio: p.current_price / p.comp_min }))
  .sort((a, b) => b.ratio - a.ratio)
  .slice(0, 100)
console.log(`Selected ${candidates.length} candidates for repricing`)
console.log(`Mode: ${APPLY ? 'APPLY (will hit eBay)' : 'DRY-RUN'}\n`)

async function reviseStartPrice(itemId, newPrice) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <Item><ItemID>${itemId}</ItemID><StartPrice currencyID="USD">${Number(newPrice).toFixed(2)}</StartPrice></Item>
</ReviseFixedPriceItemRequest>`
  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': 'ReviseFixedPriceItem', 'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-APP-NAME': env.EBAY_APP_ID,
      'X-EBAY-API-DEV-NAME': env.EBAY_DEV_ID, 'X-EBAY-API-CERT-NAME': env.EBAY_CERT_ID,
      Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml',
    },
    body: xml,
  })
  const text = await res.text()
  const ack = text.match(/<Ack>(.*?)<\/Ack>/)?.[1] || 'Unknown'
  const longMsg = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || ''
  return { ack, longMsg }
}

fs.mkdirSync('scripts/receipts', { recursive: true })
let success = 0, failed = 0, quotaHit = false

for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i]
  const oldPrice = c.current_price
  const newPrice = c.proposed
  const progress = `[${i + 1}/${candidates.length}]`
  console.log(`${progress} ${c.ebay_listing_id}  $${oldPrice} → $${newPrice}  (${c.ratio.toFixed(1)}×)`)

  let ack = 'DRY_RUN', longMsg = '', applied = false
  if (APPLY) {
    const result = await reviseStartPrice(c.ebay_listing_id, newPrice)
    ack = result.ack
    longMsg = result.longMsg
    applied = ack === 'Success' || ack === 'Warning'
    if (applied) {
      await sql(
        `UPDATE listed_asins SET ebay_price = $1, last_repriced_at = NOW(), reduction_count = COALESCE(reduction_count, 0) + 1 WHERE ebay_listing_id = $2`,
        [newPrice, c.ebay_listing_id],
      )
      success++
      process.stdout.write('  ✓\n')
    } else {
      failed++
      process.stdout.write(`  ✗ ${ack}: ${longMsg.slice(0, 100)}\n`)
      if (longMsg.toLowerCase().includes('exceeded usage limit') || longMsg.toLowerCase().includes('quota')) {
        console.log(`  → Hit eBay quota at row ${i + 1}/${candidates.length}. Stopping cleanly.`)
        quotaHit = true
        break
      }
    }
  }

  await sql(
    `INSERT INTO pricing_audit_log (ebay_listing_id, asin, old_price, new_price, reason, competitor_min, competitor_count, applied, ebay_ack, ebay_error, dry_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [c.ebay_listing_id, c.asin, oldPrice, newPrice,
     `Phase 2 reprice — ${c.ratio.toFixed(2)}× over comp min`,
     c.comp_min, c.comp_count, applied, ack, longMsg.slice(0, 500), !APPLY],
  )

  if (APPLY) await new Promise((r) => setTimeout(r, 1500))
}

console.log(`\n=== DONE ===`)
console.log(`  Mode:        ${APPLY ? 'APPLIED' : 'DRY-RUN'}`)
console.log(`  Success:     ${success}`)
console.log(`  Failed:      ${failed}`)
console.log(`  Quota hit:   ${quotaHit ? 'YES' : 'no'}`)
console.log(`  Processed:   ${success + failed} of ${candidates.length}`)
