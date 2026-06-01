// Cross-reference eBay's recent orders against our listed_asins table.
// Tells us why 119 of 121 sales didn't match.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

// Get the user token
const cred = await sql(`SELECT user_id, oauth_token, token_expires_at FROM ebay_credentials ORDER BY updated_at DESC LIMIT 5`)
console.log(`Users with credentials: ${cred.length}`)
for (const c of cred) console.log(`  user_id=${c.user_id} expires=${c.token_expires_at}`)

const u1 = cred.find((c) => Number(c.user_id) === 1) || cred[0]
const token = u1.oauth_token
const userId = u1.user_id

// Pull orders from eBay Sell Fulfillment API (last 30 days)
const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=creationdate:[${since}..]&limit=50`
const r = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, 'Content-Language': 'en-US' },
})
console.log(`\neBay /sell/fulfillment/v1/order status: ${r.status}`)
if (!r.ok) { console.log('Body:', (await r.text()).slice(0, 500)); process.exit(1) }
const j = await r.json()
const orders = j.orders || []
console.log(`Orders returned: ${orders.length} (total available: ${j.total || '?'})`)

// Extract all legacyItemIds
const ebayItemIds = []
for (const o of orders) {
  for (const li of (o.lineItems || [])) {
    if (li.legacyItemId) ebayItemIds.push(String(li.legacyItemId))
  }
}
const uniqueEbayIds = [...new Set(ebayItemIds)]
console.log(`Distinct legacyItemIds from eBay orders: ${uniqueEbayIds.length}`)
console.log(`Sample: ${uniqueEbayIds.slice(0, 5).join(', ')}`)

// Check how many of these exist in our listed_asins
const matched = await sql(`
  SELECT ebay_listing_id, user_id, ended_at IS NOT NULL AS is_ended, sold_at IS NOT NULL AS has_sale, LEFT(title, 40) title
  FROM listed_asins WHERE ebay_listing_id = ANY($1::text[])`, [uniqueEbayIds])
console.log(`\nMatched against listed_asins: ${matched.length} / ${uniqueEbayIds.length}`)
console.log(`  By user_id: ${[...new Set(matched.map((m) => m.user_id))].join(', ')}`)
console.log(`  Ended: ${matched.filter((m) => m.is_ended).length}`)
console.log(`  Already has sold_at: ${matched.filter((m) => m.has_sale).length}`)

// Show the unmatched ones
const matchedSet = new Set(matched.map((m) => m.ebay_listing_id))
const unmatched = uniqueEbayIds.filter((id) => !matchedSet.has(id))
console.log(`\nUnmatched (in eBay but NOT in our listed_asins): ${unmatched.length}`)
console.log(`Sample unmatched IDs: ${unmatched.slice(0, 10).join(', ')}`)

// Also check ANY listed_asins for those IDs (even alternate user IDs)
const orphan = await sql(`SELECT COUNT(*)::int n FROM listed_asins WHERE ebay_listing_id = ANY($1::text[])`, [unmatched])
console.log(`Of the unmatched, found in listed_asins under different conditions: ${orphan[0].n}`)

console.log(`\n=== DIAGNOSIS ===`)
if (matched.length > 0 && matched.filter((m) => m.has_sale).length > 0) {
  console.log(`Some matched listings ALREADY have sold_at set — the WHERE clause filter (sold_at IS NULL) blocks them.`)
}
console.log(`The cron pulls eBay orders successfully but matches very few back.`)
console.log(`Primary reason: ${unmatched.length} of ${uniqueEbayIds.length} sold items have eBay listing IDs that don't exist in listed_asins at all.`)
console.log(`These are listings the user created OUTSIDE StackPilot (or before tracking was added).`)
