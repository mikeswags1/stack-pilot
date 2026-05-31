// Restore wrongly-ended listings by cross-referencing eBay's actual active set.
// Paginate GetSellerList (cheap: ~7-11 calls) to build the truth-set of active
// listing IDs, then UPDATE listed_asins SET ended_at = NULL for any matching
// "ended" rows. Listings legitimately ended (sold-out, removed) don't appear in
// eBay's active set so they stay ended — restore is precise by construction.
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }),
)
const sql = neon(env.DATABASE_URL)

const cred = await sql(`SELECT oauth_token, token_expires_at FROM ebay_credentials WHERE user_id = 1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`)
if (!cred[0]) { console.error('No eBay credentials.'); process.exit(1) }
const token = cred[0].oauth_token
if (new Date(cred[0].token_expires_at) < new Date()) { console.error('Token expired — reload dashboard.'); process.exit(1) }

const now = new Date()
const to = new Date(now.getTime() + 120 * 864e5)
const iso = (d) => d.toISOString().slice(0, 19) + '.000Z'

async function getPage(page) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <EndTimeFrom>${iso(now)}</EndTimeFrom>
  <EndTimeTo>${iso(to)}</EndTimeTo>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerListRequest>`
  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': 'GetSellerList', 'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-APP-NAME': env.EBAY_APP_ID,
      'X-EBAY-API-DEV-NAME': env.EBAY_DEV_ID, 'X-EBAY-API-CERT-NAME': env.EBAY_CERT_ID,
      Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml',
    },
    body: xml,
  })
  return res.text()
}

console.log('Step 3a — Fetching eBay active listings via GetSellerList...')
const activeIds = new Set()
let page = 1
let totalPages = 1
do {
  const text = await getPage(page)
  if (page === 1) {
    totalPages = parseInt(text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] || '1', 10)
    const ack = text.match(/<Ack>(.*?)<\/Ack>/)?.[1]
    if (ack === 'Failure') {
      const long = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || text.slice(0, 400)
      console.error('eBay GetSellerList failed:', long)
      process.exit(1)
    }
    console.log(`  Total pages: ${totalPages}`)
  }
  for (const m of text.matchAll(/<ItemID>(\d+)<\/ItemID>/g)) activeIds.add(m[1])
  process.stdout.write(`  page ${page}/${totalPages}: ${activeIds.size} active so far\r`)
  page++
  await new Promise((r) => setTimeout(r, 400))
} while (page <= totalPages)
console.log(`\n  → ${activeIds.size} distinct active listing IDs from eBay\n`)

if (activeIds.size < 1000) {
  console.error(`SAFETY ABORT — only ${activeIds.size} active IDs from eBay; this seems too low. Not restoring. Investigate before retrying.`)
  process.exit(1)
}

console.log('Step 3b — Computing restore candidates...')
const candidates = await sql(`
  SELECT id, ebay_listing_id, COALESCE(amazon_status_reason, '(none)') reason
  FROM listed_asins
  WHERE ebay_listing_id IS NOT NULL AND ebay_listing_id <> '' AND ended_at IS NOT NULL`)
const toRestore = candidates.filter((c) => activeIds.has(String(c.ebay_listing_id)))
console.log(`  Ended rows in DB:                  ${candidates.length}`)
console.log(`  Of those, eBay says active:        ${toRestore.length}  ← will restore`)
console.log(`  Genuinely ended (sold/removed):    ${candidates.length - toRestore.length}  ← leave alone`)

// Breakdown of what we're restoring by reason — useful for the post-mortem
const reasonBreakdown = new Map()
for (const c of toRestore) reasonBreakdown.set(c.reason, (reasonBreakdown.get(c.reason) || 0) + 1)
console.log('\n  Restore set breakdown by status reason:')
for (const [r, n] of [...reasonBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(r).padEnd(40)} ${n}`)
}

if (toRestore.length === 0) { console.log('\nNothing to restore.'); process.exit(0) }

console.log('\nStep 3c — Executing UPDATE...')
const restoreIds = toRestore.map((c) => c.id)
const updated = await sql(`
  UPDATE listed_asins SET ended_at = NULL WHERE id = ANY($1::int[])
  RETURNING id`, [restoreIds])
console.log(`  UPDATE returned ${updated.length} rows changed`)

const verify = await sql(`
  SELECT COUNT(*) FILTER (WHERE ended_at IS NULL)::int active_now
  FROM listed_asins
  WHERE ebay_listing_id IS NOT NULL AND ebay_listing_id <> ''`)
console.log(`\n  Post-restore: ${verify[0].active_now} listings now active (with eBay IDs)`)
console.log(`  eBay's truth: ${activeIds.size} active listings`)
console.log(`  Delta:        ${activeIds.size - verify[0].active_now} (eBay listings we don't have records for — older listings made outside StackPilot)`)
