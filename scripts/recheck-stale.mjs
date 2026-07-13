// DISABLED (2026-07-13): this standalone script pays ScraperAPI credits OUTSIDE the
// app quota tracker (a 700-item sweep burned ~3.5k credits invisibly). The production
// pipeline covers this job now: the free listingAuditOnly cron verifies every live
// listing on a 6h/48h/7d cadence, and listing-time verification draws from a tracked,
// reserved paid bucket. Set FORCE_PAID_SWEEP=1 only for a deliberate one-off.
if (process.env.FORCE_PAID_SWEEP !== '1') {
  console.log('DISABLED: paid sweep bypasses quota tracking. The production audit cron covers this. Set FORCE_PAID_SWEEP=1 for a deliberate one-off.')
  process.exit(0)
}
// Rolling stale-price re-check â€” catches Amazon price drift BEFORE it sells at a loss
// (a $25 monitor arm quietly became $99.99 and sold at $44.99). Re-verifies live
// listings oldest/riskiest first, updates amazon_price, and ENDS listings that now
// break the rules: explicit OOS, no Prime, selling at a loss, or ROI < 8%.
// Missing/ambiguous data NEVER ends a listing. Receipts: scripts/receipts/stale-ended.jsonl
// Run: node scripts/recheck-stale.mjs [batch=250]
console.log('DISABLED FOR SAFETY: use the verified production listingAuditOnly sweep. This legacy script bypasses quota tracking and does not use canonical true-net profit math.')
process.exit(0)

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)
const BATCH = Math.max(20, Math.min(600, Number(process.argv[2] || '250')))
const FEE = 0.136, AD = 0.02, ROI_MIN = 0.08

await sql(`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS price_rechecked_at TIMESTAMPTZ`).catch(()=>{})

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

// Riskiest first: thinnest recorded margins, then longest-unchecked.
const rows = await sql(`
  SELECT ebay_listing_id, asin, title, ebay_price::float ep, amazon_price::float ap, user_id
  FROM listed_asins
  WHERE user_id = ANY($1::int[]) AND ended_at IS NULL AND ebay_listing_id <> ''
    AND (price_rechecked_at IS NULL OR price_rechecked_at < NOW() - INTERVAL '7 days')
  ORDER BY (CASE WHEN amazon_price > 0 AND ebay_price > 0 THEN amazon_price/ebay_price ELSE 0.5 END) DESC,
           COALESCE(price_rechecked_at, '2000-01-01') ASC
  LIMIT $2`, [[1,3], BATCH])
console.log(`Re-checking ${rows.length} live listings (riskiest margins first)`)

const parsePrice=s=>{const m=String(s||'').match(/([\d,]+\.\d{2})/);return m?parseFloat(m[1].replace(/,/g,'')):null}
let healthy=0, ended=0, repriceNeeded=0, unknown=0, credits=false
const receipts=[]
for(const r of rows){
  let d=null
  for(let a=0;a<2;a++){
    const res=await fetch(`https://api.scraperapi.com/structured/amazon/product?api_key=${env.SCRAPERAPI_KEY}&asin=${r.asin}&country=us`,{signal:AbortSignal.timeout(45000)}).catch(()=>null)
    if(res && [401,403,429].includes(res.status)){ credits=true; break }
    if(res && res.status===200){ d=await res.json().catch(()=>null); if(d?.availability_status||d?.pricing) break }
    await new Promise(x=>setTimeout(x,1200))
  }
  if(credits){ console.log('credit/rate stop â€” resuming next run'); break }
  const avail=String(d?.availability_status||'').trim()
  const price=parsePrice(d?.pricing)
  const soldBy=String(d?.sold_by||''), shipsFrom=String(d?.ships_from||'')
  const explicitOOS=/unavailable|out of stock|temporarily out/i.test(avail)
  const explicitInStock=/in stock|left in stock/i.test(avail) && !explicitOOS
  const haveSeller=!!(soldBy||shipsFrom)
  const fast=/amazon/i.test(soldBy)||/amazon/i.test(shipsFrom)
  // mark checked regardless (retry in 7 days)
  await sql(`UPDATE listed_asins SET price_rechecked_at=NOW(), amazon_price=COALESCE($2,amazon_price) WHERE ebay_listing_id=$1`,[r.ebay_listing_id, explicitInStock?price:null]).catch(()=>{})
  if(!d || (!explicitOOS && !explicitInStock)){ unknown++; continue }

  const reasons=[]
  if(explicitOOS) reasons.push('OUT_OF_STOCK')
  if(explicitInStock && haveSeller && !fast) reasons.push('NO_PRIME')
  if(explicitInStock && price!=null && price>0){
    const net=r.ep*(1-FEE-AD)-0.4, roi=(net-price)/price
    if(price>net) reasons.push('NOW_UNPROFITABLE')
    else if(roi<ROI_MIN) reasons.push('LOW_ROI')
  }
  if(reasons.length===0){ healthy++; continue }

  console.log(`END [${reasons.join(',')}] was amz $${r.ap} now $${price??'?'} | ebay $${r.ep} | ${r.title.slice(0,45)}`)
  receipts.push({at:new Date().toISOString(), ebay_listing_id:r.ebay_listing_id, asin:r.asin, title:r.title, ebay_price:r.ep, old_amz:r.ap, new_amz:price, reasons})
  const token=tokens[r.user_id]; if(!token) continue
  const xml=`<?xml version="1.0" encoding="utf-8"?>\n<EndItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials><ItemID>${r.ebay_listing_id}</ItemID><EndingReason>NotAvailable</EndingReason></EndItemRequest>`
  const res=await fetch('https://api.ebay.com/ws/api.dll',{method:'POST',headers:{'X-EBAY-API-CALL-NAME':'EndItem','X-EBAY-API-SITEID':'0','X-EBAY-API-COMPATIBILITY-LEVEL':'967','X-EBAY-API-APP-NAME':env.EBAY_APP_ID,'Content-Type':'text/xml'},body:xml}).catch(()=>null)
  const tx=res?await res.text():''
  if(/exceeded usage limit/i.test(tx)){ console.log('eBay quota stop'); break }
  if(/<Ack>Success<\/Ack>|<Ack>Warning<\/Ack>/.test(tx)||/already|ended|closed|not found/i.test(tx)){
    ended++
    await sql(`UPDATE listed_asins SET ended_at=NOW(), amazon_status_reason=$2 WHERE ebay_listing_id=$1 AND ended_at IS NULL`,[r.ebay_listing_id,'stale_'+reasons.join(',')])
  }
  await new Promise(x=>setTimeout(x,150))
}
if(receipts.length) fs.appendFileSync(path.resolve(process.cwd(),'scripts/receipts/stale-ended.jsonl'), receipts.map(x=>JSON.stringify(x)).join('\n')+'\n')
console.log(`\nRESULT: ${healthy} healthy, ${ended} ended, ${unknown} no-data (untouched)`)
