// DISABLED (2026-07-13): this standalone script pays ScraperAPI credits OUTSIDE the
// app quota tracker (a 700-item sweep burned ~3.5k credits invisibly). The production
// pipeline covers this job now: the free listingAuditOnly cron verifies every live
// listing on a 6h/48h/7d cadence, and listing-time verification draws from a tracked,
// reserved paid bucket. Set FORCE_PAID_SWEEP=1 only for a deliberate one-off.
if (process.env.FORCE_PAID_SWEEP !== '1') {
  console.log('DISABLED: paid sweep bypasses quota tracking. The production audit cron covers this. Set FORCE_PAID_SWEEP=1 for a deliberate one-off.')
  process.exit(0)
}
// Daily re-check of PREVIOUSLY-SOLD live listings â€” the items most likely to sell again.
// A sold item that goes out of stock on Amazon is the #1 defect source (order arrives,
// nothing to buy). Pulls 90 days of eBay orders, maps them to live listings, verifies
// each on Amazon (ScraperAPI structured), and ENDS only explicit "unavailable" reads
// (missing data NEVER ends a listing â€” see the false-OOS incident 7/2).
// Run: node scripts/recheck-sold.mjs   (add --dry to preview without ending)
console.log('DISABLED FOR SAFETY: this legacy script performs paid calls and DB writes even in dry mode. Sold-listing checks must use the quota-gated verified workflow.')
process.exit(0)

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)
const DRY = process.argv.includes('--dry')

async function getToken(u){
  let rr = await sql(`SELECT oauth_token, refresh_token, token_expires_at FROM ebay_accounts WHERE user_id=$1 AND active=TRUE ORDER BY id ASC LIMIT 1`,[String(u)]).catch(()=>[])
  if(!rr[0]) rr = await sql(`SELECT oauth_token, refresh_token, token_expires_at FROM ebay_credentials WHERE user_id=$1 LIMIT 1`,[String(u)]).catch(()=>[])
  const c=rr[0]; if(!c) return null
  const expired = !c.token_expires_at || new Date(c.token_expires_at) < new Date(Date.now()+5*60*1000)
  if(c.oauth_token && !expired) return c.oauth_token
  const basic=Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
  const res=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:c.refresh_token,scope:'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory'})})
  const d=await res.json(); return d.access_token||null
}
const tokens = { 1: await getToken(1), 3: await getToken(3) }

// 1) Collect sold item IDs from eBay orders (both accounts, 90 days).
const soldItemIds = new Set()
for(const u of [1,3]){
  const token = tokens[u]; if(!token) continue
  const from = new Date(Date.now()-89*86400000).toISOString(), to = new Date().toISOString()
  for(let page=1; page<=5; page++){
    const xml=`<?xml version="1.0" encoding="utf-8"?>\n<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><CreateTimeFrom>${from}</CreateTimeFrom><CreateTimeTo>${to}</CreateTimeTo><OrderRole>Seller</OrderRole><OrderStatus>All</OrderStatus><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></GetOrdersRequest>`
    const res=await fetch('https://api.ebay.com/ws/api.dll',{method:'POST',headers:{'X-EBAY-API-CALL-NAME':'GetOrders','X-EBAY-API-SITEID':'0','X-EBAY-API-COMPATIBILITY-LEVEL':'967','X-EBAY-API-APP-NAME':env.EBAY_APP_ID,'Content-Type':'text/xml'},body:xml}).catch(()=>null)
    if(!res) break
    const tx=await res.text()
    for(const m of tx.matchAll(/<ItemID>(\d+)<\/ItemID>/g)) soldItemIds.add(m[1])
    if(!/<HasMoreOrders>true<\/HasMoreOrders>/.test(tx)) break
  }
}
console.log(`sold item IDs found: ${soldItemIds.size}`)

// 2) Which of those map to LIVE listings, and what ASINs do they (or their same-ASIN twins) use?
const ids = [...soldItemIds]
const live = ids.length ? await sql(`
  SELECT DISTINCT l2.ebay_listing_id, l2.asin, l2.title, l2.user_id
  FROM listed_asins l1
  JOIN listed_asins l2 ON UPPER(l2.asin)=UPPER(l1.asin)
  WHERE l1.ebay_listing_id = ANY($1::text[]) AND l2.ended_at IS NULL AND l2.ebay_listing_id<>''`,[ids]) : []
console.log(`live listings tied to sold ASINs: ${live.length}`)

// 3) Verify each on Amazon; END only explicit-OOS.
const parsePrice=s=>{const m=String(s||'').match(/([\d,]+\.\d{2})/);return m?parseFloat(m[1].replace(/,/g,'')):null}
let ok=0, ended=0, unknown=0
const receipts=[]
for(const r of live){
  let d=null
  for(let a=0;a<2;a++){
    const res=await fetch(`https://api.scraperapi.com/structured/amazon/product?api_key=${env.SCRAPERAPI_KEY}&asin=${r.asin}&country=us`,{signal:AbortSignal.timeout(45000)}).catch(()=>null)
    if(res && res.status===200){ d=await res.json().catch(()=>null); if(d?.availability_status||d?.pricing) break }
    if(res && [401,403,429].includes(res.status)){ console.log('credits/rate stop'); d=null; break }
    await new Promise(x=>setTimeout(x,1500))
  }
  const avail=String(d?.availability_status||'').trim()
  const explicitOOS=/unavailable|out of stock|temporarily out/i.test(avail)
  if(!d || !avail){ unknown++; continue }              // missing data: never act
  if(!explicitOOS){ ok++; await sql(`UPDATE listed_asins SET amazon_price=COALESCE($2,amazon_price) WHERE ebay_listing_id=$1`,[r.ebay_listing_id, parsePrice(d.pricing)]).catch(()=>{}); continue }
  console.log(`OOS: ${r.ebay_listing_id}  ${r.title.slice(0,50)}`)
  receipts.push({ebay_listing_id:r.ebay_listing_id, asin:r.asin, title:r.title, reason:'SOLD_ITEM_WENT_OOS'})
  if(DRY) { ended++; continue }
  const token=tokens[r.user_id]; if(!token) continue
  const xml=`<?xml version="1.0" encoding="utf-8"?>\n<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ItemID>${r.ebay_listing_id}</ItemID><EndingReason>NotAvailable</EndingReason></EndItemRequest>`
  const res=await fetch('https://api.ebay.com/ws/api.dll',{method:'POST',headers:{'X-EBAY-API-CALL-NAME':'EndItem','X-EBAY-API-SITEID':'0','X-EBAY-API-COMPATIBILITY-LEVEL':'967','X-EBAY-API-APP-NAME':env.EBAY_APP_ID,'Content-Type':'text/xml'},body:xml}).catch(()=>null)
  const tx=res?await res.text():''
  if(/<Ack>Success<\/Ack>|<Ack>Warning<\/Ack>/.test(tx)||/already|ended|closed|not found/i.test(tx)){
    ended++
    await sql(`UPDATE listed_asins SET ended_at=NOW(), amazon_status_reason='sold_item_oos_recheck' WHERE ebay_listing_id=$1 AND ended_at IS NULL`,[r.ebay_listing_id])
  }
  await new Promise(x=>setTimeout(x,150))
}
if(receipts.length) fs.appendFileSync(path.resolve(process.cwd(),'scripts/receipts/sold-recheck-ended.jsonl'), receipts.map(x=>JSON.stringify({at:new Date().toISOString(),...x})).join('\n')+'\n')
console.log(`\nRESULT: ${ok} healthy, ${ended} ${DRY?'WOULD-end':'ended'} (OOS), ${unknown} no-data (untouched)`)
