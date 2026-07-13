// DISABLED (2026-07-13): this standalone script pays ScraperAPI credits OUTSIDE the
// app quota tracker (a 700-item sweep burned ~3.5k credits invisibly). The production
// pipeline covers this job now: the free listingAuditOnly cron verifies every live
// listing on a 6h/48h/7d cadence, and listing-time verification draws from a tracked,
// reserved paid bucket. Set FORCE_PAID_SWEEP=1 only for a deliberate one-off.
if (process.env.FORCE_PAID_SWEEP !== '1') {
  console.log('DISABLED: paid sweep bypasses quota tracking. The production audit cron covers this. Set FORCE_PAID_SWEEP=1 for a deliberate one-off.')
  process.exit(0)
}
console.log('DISABLED FOR SAFETY: use the verified production listingAuditOnly sweep. This legacy script marks ambiguous reads audited and bypasses the ScraperAPI hard cap.')
process.exit(0)

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'; import path from 'node:path'
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i=l.indexOf('='); return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')] })
)
const sql = neon(env.DATABASE_URL)
const KEY = env.SCRAPERAPI_KEY
const FEE = 0.136
const ROI_MIN = 0.08   // delete below 8% ROI â€” user's listing floor is 10% (auto_listing_settings.min_roi); the 2-point buffer stops list-at-10%/delete-at-10% churn
const LIMIT = Number(process.argv[2] || '300')
const ACCOUNTS = [1, 3]

// Track every listing we audit so we NEVER re-check it (saves ScraperAPI credits).
await sql(`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS cleanup_audited_at TIMESTAMPTZ`).catch(()=>{})
await sql(`ALTER TABLE listed_asins ADD COLUMN IF NOT EXISTS cleanup_reasons TEXT`).catch(()=>{})

// One-time: fold any previously-found candidates into the DB so they're counted + not re-checked.
try {
  const prev = JSON.parse(fs.readFileSync(path.resolve(process.cwd(),'scripts/receipts/cleanup-candidates.json'),'utf-8'))
  let n=0
  for(const c of prev){ const r=await sql(`UPDATE listed_asins SET cleanup_audited_at=COALESCE(cleanup_audited_at,NOW()), cleanup_reasons=COALESCE(cleanup_reasons,$2) WHERE ebay_listing_id=$1 AND ended_at IS NULL RETURNING id`,[c.ebay_listing_id, c.reasons.join(',')]).catch(()=>[]); n+=r.length }
  if(n) console.log(`(carried ${n} previously-found candidates into the DB)`)
} catch {}

const parsePrice=s=>{const m=String(s||'').match(/([\d,]+\.\d{2})/);return m?parseFloat(m[1].replace(/,/g,'')):null}
async function look(asin){
  const url=`https://api.scraperapi.com/structured/amazon/product?api_key=${KEY}&asin=${asin}&country=us`
  for(let attempt=0; attempt<2; attempt++){
    try{
      const res=await fetch(url,{signal:AbortSignal.timeout(45000)})
      if(res.status===401||res.status===403||res.status===429) return {err:'CREDITS'}  // out of credits / rate â€” stop
      if(res.status!==200){ if(attempt===0){await new Promise(r=>setTimeout(r,1500));continue} return {err:'http_'+res.status} }
      const d=await res.json()
      if(d && (d.availability_status || d.pricing)) return d
      if(attempt===0){ await new Promise(r=>setTimeout(r,1500)); continue }
      return d
    }catch(e){ if(attempt===0){await new Promise(r=>setTimeout(r,1500));continue} return {err:e.name==='TimeoutError'?'timeout':'err'} }
  }
}

// Un-audited live listings, walked systematically (newest first) so batches never overlap.
const listings = await sql(`
  SELECT ebay_listing_id, asin, title, ebay_price::float AS ebay_price, user_id
  FROM listed_asins
  WHERE user_id = ANY($1::int[]) AND ended_at IS NULL AND ebay_listing_id <> '' AND cleanup_audited_at IS NULL
  ORDER BY listed_at DESC LIMIT $2`, [ACCOUNTS, LIMIT])
const remain = (await sql(`SELECT COUNT(*)::int n FROM listed_asins WHERE user_id=ANY($1::int[]) AND ended_at IS NULL AND ebay_listing_id<>'' AND cleanup_audited_at IS NULL`,[ACCOUNTS]))[0].n
console.log(`Auditing ${listings.length} NEW listings (${remain} un-audited remain in store) â€” DRY RUN\n`)

const del=[]; let keep=0, failed=0, creditsOut=false, cursor=0, done=0
const CONC = 10   // ScraperAPI Hobby allows 20 concurrent threads; 10 = safe headroom
async function processOne(l){
  const d=await look(l.asin)
  if(d?.err==='CREDITS'){ creditsOut=true; return }
  let reasons=[], price=null, soldBy='', verdict
  if(d.err){ verdict='CHECK_FAILED'; failed++ }
  else{
    const avail=String(d.availability_status||'').trim()
    price=parsePrice(d.pricing); soldBy=String(d.sold_by||''); const shipsFrom=String(d.ships_from||'')
    const explicitOOS=/unavailable|out of stock|temporarily out/i.test(avail)
    const explicitInStock=/in stock/i.test(avail) && !explicitOOS
    const haveSeller=!!(soldBy||shipsFrom)
    const fast=/amazon/i.test(soldBy)||/amazon/i.test(shipsFrom)
    if(!explicitOOS && !explicitInStock){ verdict='CHECK_FAILED'; failed++ }
    else{
      if(explicitOOS) reasons.push('OUT_OF_STOCK')
      if(explicitInStock && haveSeller && !fast) reasons.push('NO_PRIME')
      if(explicitInStock && price!=null && price>0){
        const net=l.ebay_price*(1-FEE), roi=(net-price)/price
        if(price>net) reasons.push('NOT_PROFITABLE')      // ROI below 0 (a loss)
        else if(roi<ROI_MIN) reasons.push('LOW_ROI')       // profitable but margin too thin
      }
      verdict = reasons.length ? reasons.join(',') : (keep++, 'KEEP')
    }
  }
  // Mark audited regardless of outcome â€” this is the credit-saving tracker.
  // Retry the DB write up to 3x (transient ECONNRESETs happen under concurrency).
  for(let a=0; a<3; a++){
    try{ await sql(`UPDATE listed_asins SET cleanup_audited_at=NOW(), cleanup_reasons=$2, amazon_price=COALESCE($3, amazon_price) WHERE user_id=${l.user_id} AND ebay_listing_id=$1`,[l.ebay_listing_id, verdict, price]); break }
    catch(e){ if(a===2) throw e; await new Promise(r=>setTimeout(r,1000*(a+1))) }
  }
  if(reasons.length){ del.push({ebay_listing_id:l.ebay_listing_id, asin:l.asin, title:l.title, ebay_price:l.ebay_price, amazon_price:price, sold_by:soldBy.slice(0,20), reasons}); console.log(`DELETE  eBay $${l.ebay_price} amz $${price??'?'} [${reasons.join(',')}]  ${l.title.slice(0,30)}`) }
  else if(verdict==='CHECK_FAILED') console.log(`CHECK_FAIL  ${l.title.slice(0,28)}  (no stock data â€” skipped)`)
}
async function worker(){
  while(!creditsOut){
    const i = cursor++
    if(i >= listings.length) break
    // One bad listing/blip must never kill the run â€” it stays un-marked and resumes next time.
    try{ await processOne(listings[i]) }
    catch(e){ failed++; console.log(`  (skip ${listings[i].asin}: ${String(e.message||e).slice(0,50)})`) }
    if(++done % 250 === 0) console.log(`  ...${done}/${listings.length} audited (${del.length} invalid so far)`)
  }
}
await Promise.all(Array.from({length:CONC}, ()=>worker()))
if(creditsOut) console.log('\nâš  ScraperAPI credits exhausted â€” stopping. Un-marked listings resume next time.')
fs.writeFileSync(path.resolve(process.cwd(),'scripts/receipts/cleanup-candidates.json'), JSON.stringify(del,null,2))
console.log(`\n=== THIS BATCH: ${del.length} invalid, ${keep} keep, ${failed} check-failed (of ${listings.length}) ===`)
const t = await sql(`SELECT
  COUNT(*) FILTER (WHERE cleanup_audited_at IS NOT NULL)::int audited,
  COUNT(*) FILTER (WHERE cleanup_reasons IS NOT NULL AND cleanup_reasons NOT IN ('KEEP','CHECK_FAILED'))::int invalid_pending
  FROM listed_asins WHERE user_id=ANY($1::int[]) AND ended_at IS NULL`,[ACCOUNTS])
console.log(`STORE TOTAL: ${t[0].audited} audited so far, ${t[0].invalid_pending} invalid pending deletion`)
