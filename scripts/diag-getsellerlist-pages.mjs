import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)
const c = await sql(`SELECT oauth_token FROM ebay_credentials WHERE user_id = 1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`)
const token = c[0].oauth_token
const now = new Date(); const to = new Date(now.getTime() + 120 * 864e5)
const iso = d => d.toISOString().slice(0, 19) + '.000Z'

for (const page of [1, 2, 3]) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <EndTimeFrom>${iso(now)}</EndTimeFrom>
  <EndTimeTo>${iso(to)}</EndTimeTo>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetSellerListRequest>`
  const r = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: { 'X-EBAY-API-CALL-NAME': 'GetSellerList', 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-APP-NAME': env.EBAY_APP_ID, 'X-EBAY-API-DEV-NAME': env.EBAY_DEV_ID, 'X-EBAY-API-CERT-NAME': env.EBAY_CERT_ID, Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml' },
    body: xml,
  })
  const text = await r.text()
  const ack = text.match(/<Ack>(.*?)<\/Ack>/)?.[1]
  const itemCount = [...text.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].length
  const totalPages = text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1]
  const totalEntries = text.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/)?.[1]
  const longMsg = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1]
  const errCode = text.match(/<ErrorCode>(\d+)<\/ErrorCode>/)?.[1]
  console.log(`Page ${page}: ack=${ack} status=${r.status} itemIDs=${itemCount} totalPages=${totalPages} totalEntries=${totalEntries}`)
  if (longMsg) console.log(`  msg: ${longMsg.slice(0, 200)}`)
  if (errCode) console.log(`  err: ${errCode}`)
  await new Promise(r => setTimeout(r, 600))
}
