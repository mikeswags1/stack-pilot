// MINIMUM VIABLE pricing applier — repricies the 20 worst overpricers from
// the latest proposal JSON to their competitive price. Kill switch via
// PRICING_KILL_SWITCH env var. Per-listing receipt written to
// scripts/receipts/. Audit log row inserted for every attempt.
// DRY-RUN by default; pass --apply to actually call eBay.

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const APPLY = process.argv.includes('--apply')
const KILL = process.env.PRICING_KILL_SWITCH === '1' || env.PRICING_KILL_SWITCH === '1'
if (KILL) { console.error('PRICING_KILL_SWITCH=1 — aborting'); process.exit(1) }

const sql = neon(env.DATABASE_URL)

// Ensure audit log table exists
await sql(`
  CREATE TABLE IF NOT EXISTS pricing_audit_log (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ebay_listing_id TEXT NOT NULL,
    asin TEXT,
    old_price NUMERIC(10,2),
    new_price NUMERIC(10,2),
    reason TEXT,
    competitor_min NUMERIC(10,2),
    competitor_count INTEGER,
    applied BOOLEAN,
    ebay_ack TEXT,
    ebay_error TEXT,
    dry_run BOOLEAN
  )
`)
await sql(`CREATE INDEX IF NOT EXISTS pricing_audit_listing_idx ON pricing_audit_log (ebay_listing_id, created_at DESC)`)

// Get eBay credentials
const cred = await sql(`SELECT oauth_token, token_expires_at FROM ebay_credentials WHERE user_id = 1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`)
if (!cred[0]) { console.error('No eBay credentials'); process.exit(1) }
const token = cred[0].oauth_token
if (new Date(cred[0].token_expires_at) < new Date()) { console.error('Token expired'); process.exit(1) }

// Load latest proposal
const proposalsDir = 'scripts/proposals'
const files = fs.readdirSync(proposalsDir).filter((f) => f.startsWith('dynamic-pricing-proposal-')).sort().reverse()
const latest = JSON.parse(fs.readFileSync(path.join(proposalsDir, files[0]), 'utf-8'))

// Pick the 20 worst overpricers from REPRICE_DOWN bucket — biggest current/min ratio
const candidates = latest.proposals
  .filter((p) => p.outcome === 'REPRICE_DOWN')
  .map((p) => ({ ...p, ratio: p.current_price / p.comp_min }))
  .sort((a, b) => b.ratio - a.ratio)
  .slice(0, 20)

console.log(`Mode: ${APPLY ? 'APPLY (will hit eBay)' : 'DRY-RUN (no eBay calls)'}`)
console.log(`Selected ${candidates.length} worst overpricers from latest proposal\n`)

// HARD NET-PROFIT FLOOR GUARD (2026-06-10). On May 31-Jun 1 this script cut 118
// listings below cost because it trusted comp-min prices with no profit check
// (see COLLAB.md). Mirrors getNetProfit()/priceForNetProfit() in
// lib/listing-pricing.ts. NEVER remove this guard.
const MIN_NET_PROFIT = Number(env.MIN_NET_PROFIT || '5')
const FLOOR_FEE_RATE = 0.136, FLOOR_BUFFER = 0.015
const FLOOR_PROMO = Number(env.PROMOTED_AD_RATE || '0.06')
const FLOOR_TAX = Number(env.AMAZON_SOURCE_TAX_RATE || '0.07')
async function netFloorFor(listingId) {
  const rows = await sql(
    `SELECT la.amazon_price, apc.amazon_price AS cache_price
     FROM listed_asins la
     LEFT JOIN amazon_product_cache apc ON UPPER(apc.asin) = UPPER(la.asin)
     WHERE la.ebay_listing_id = $1 LIMIT 1`, [listingId])
  const r = rows[0]
  if (!r) return null
  const cost = Number(r.cache_price) > 0 ? Number(r.cache_price) : Number(r.amazon_price)
  if (!(cost > 0)) return null
  const landed = cost * (1 + FLOOR_TAX)
  return (landed + 0.4 + MIN_NET_PROFIT) / (1 - FLOOR_FEE_RATE - FLOOR_BUFFER - FLOOR_PROMO)
}

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
  return { ack, longMsg, text }
}

fs.mkdirSync('scripts/receipts', { recursive: true })

let success = 0, failed = 0
for (const c of candidates) {
  const oldPrice = c.current_price
  const newPrice = c.proposed
  const reason = `Reprice down from $${oldPrice} to $${newPrice} (was ${c.ratio.toFixed(2)}× competitor min $${c.comp_min}; ${c.comp_count} competitors)`

  console.log(`${c.ebay_listing_id}  $${oldPrice} → $${newPrice}  (${c.ratio.toFixed(1)}× → ${(newPrice / c.comp_min).toFixed(2)}×)  ${c.title?.slice(0, 40)}`)

  const netFloor = await netFloorFor(c.ebay_listing_id)
  if (netFloor == null) {
    console.log('  ⛔ SKIP — Amazon cost unknown, cannot verify profit')
    continue
  }
  if (Number(newPrice) < netFloor) {
    console.log(`  ⛔ SKIP — $${newPrice} is below the $${MIN_NET_PROFIT} net-profit floor price $${netFloor.toFixed(2)}`)
    continue
  }

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
      console.log(`  ✓ ${ack}`)
    } else {
      failed++
      console.log(`  ✗ ${ack} — ${longMsg.slice(0, 120)}`)
    }
  } else {
    console.log(`  (dry-run, no eBay call)`)
  }

  // Audit log + per-listing receipt
  await sql(
    `INSERT INTO pricing_audit_log (ebay_listing_id, asin, old_price, new_price, reason, competitor_min, competitor_count, applied, ebay_ack, ebay_error, dry_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [c.ebay_listing_id, c.asin, oldPrice, newPrice, reason, c.comp_min, c.comp_count, applied, ack, longMsg.slice(0, 500), !APPLY],
  )
  const receipt = `scripts/receipts/${c.ebay_listing_id}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  fs.writeFileSync(receipt, JSON.stringify({
    timestamp: new Date().toISOString(),
    dry_run: !APPLY,
    listing: c,
    action: { old_price: oldPrice, new_price: newPrice, reason },
    ebay_response: { ack, longMsg },
    applied,
  }, null, 2))

  if (APPLY) await new Promise((r) => setTimeout(r, 1500)) // pace eBay calls
}

console.log(`\n=== DONE ===`)
console.log(`  Mode:    ${APPLY ? 'APPLIED' : 'DRY-RUN'}`)
console.log(`  Success: ${success}`)
console.log(`  Failed:  ${failed}`)
console.log(`  Audit log rows: ${candidates.length}`)
console.log(`  Receipts saved to scripts/receipts/`)
