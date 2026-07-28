// FREE LOCAL LISTER — the full listing pipeline from the owner's laptop:
// pick pool candidates -> live-verify on Amazon via HOME IP (free, rarely blocked)
// -> enforce EVERY listing gate -> create the eBay listing -> record in listed_asins
// so all cloud safety systems track it like any other listing.
//
// Gates (identical standards to the cloud pipeline, never weakened):
//   - live buy box + core-price read (scoped parsing)
//   - title match pool vs page (word overlap >= 0.42) — blocks ASIN drift
//   - explicit fast fulfillment (ships-from-Amazon OR delivery <= 4 days)
//   - >= 2 product images from the live page
//   - net profit >= $5 AND ROI >= 10% at the FRESH price (repriced if needed)
//   - per-account duplicate check
// Run: node scripts/local-lister.mjs [batch=12] [--apply]   (default = dry run)
import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'
const env = Object.fromEntries(fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const sql = neon(env.DATABASE_URL)
const BATCH = Math.max(1, Math.min(60, Number(process.argv[2] || '12')))
const APPLY = process.argv.includes('--apply')
const USER_ID = 1

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}
const FEE = 0.136, AD = 0.02, BUF = 0.015, TAX = 1.07, FLOOR = 5, MIN_ROI = 0.10
const net = (ebay, amz) => ebay * (1 - FEE - AD - BUF) - (ebay <= 10 ? 0.30 : 0.40) - amz * TAX
const decode = (s) => String(s || '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()

async function getToken(u) {
  const rr = await sql(`SELECT oauth_token, refresh_token, token_expires_at FROM ebay_accounts WHERE user_id=$1 AND active=TRUE ORDER BY id ASC LIMIT 1`, [String(u)])
  const c = rr[0]; if (!c) return null
  const expired = !c.token_expires_at || new Date(c.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)
  if (c.oauth_token && !expired) return c.oauth_token
  const basic = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token }) })
  const d = await res.json(); return d.access_token || null
}
async function ebayCall(name, xml) {
  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: { 'X-EBAY-API-CALL-NAME': name, 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '967', 'X-EBAY-API-APP-NAME': env.EBAY_APP_ID, 'Content-Type': 'text/xml' },
    body: xml,
  })
  return res.text()
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Candidates: not yet listed on this account, decent pool economics, not rejected.
const candidates = await sql(`
  SELECT psi.asin, psi.title, psi.source_niche, psi.amazon_price::float AS pool_amz,
         psi.ebay_price::float AS pool_ebay, psi.roi::float AS roi
  FROM product_source_items psi
  WHERE psi.active = TRUE
    AND COALESCE(psi.source_quality, 'candidate') <> 'reject'
    AND psi.risk <> 'HIGH'
    AND psi.asin ~ '^[A-Z0-9]{10}$'
    AND NOT EXISTS (SELECT 1 FROM listed_asins la WHERE la.user_id = $1 AND la.asin = psi.asin AND la.ended_at IS NULL)
  ORDER BY psi.intelligence_score DESC NULLS LAST, psi.total_score DESC NULLS LAST
  LIMIT $2
`, [USER_ID, BATCH * 3])
console.log(`${candidates.length} candidates to try (target ${BATCH} listings) ${APPLY ? '' : '[DRY RUN]'}`)

const token = APPLY ? await getToken(USER_ID) : null
let listed = 0, skipped = 0
const receipts = []
for (const c of candidates) {
  if (listed >= BATCH) break
  await new Promise((x) => setTimeout(x, 12000 + Math.floor(Math.random() * 10000))) // 12-22s
  let html = ''
  let pageGone = false
  try {
    const res = await fetch(`https://www.amazon.com/dp/${c.asin}`, { headers: HEADERS, signal: AbortSignal.timeout(25000) })
    if (res.status === 404) pageGone = true
    html = res.ok ? await res.text() : ''
  } catch { /* blocked */ }
  const captcha = /captcha|Robot Check|automated access/i.test(html.slice(0, 3000))
  if (pageGone) {
    if (APPLY) await sql(`UPDATE product_source_items SET active = FALSE, source_quality = 'reject' WHERE asin = $1`, [c.asin])
    skipped++; console.log(`  SKIP page-gone ${c.asin}`); continue
  }
  if (!html || captcha) { skipped++; console.log(`  SKIP blocked ${c.asin} (html=${html.length}, captcha=${captcha})`); continue }

  // ── Gates ──
  const titleM = html.match(/<span id="productTitle"[^>]*>\s*([^<]+)/)
  const liveTitle = decode(titleM?.[1] || '')
  if (!liveTitle) { skipped++; console.log(`  SKIP no-title ${c.asin}`); continue }
  const words = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2))
  const pw = words(decode(c.title)), lw = words(liveTitle)
  let overlap = 0; for (const w of pw) if (lw.has(w)) overlap++
  if (pw.size === 0 || overlap / pw.size < 0.42) {
    if (APPLY) await sql(`UPDATE product_source_items SET active = FALSE, source_quality = 'reject' WHERE asin = $1`, [c.asin])
    skipped++; console.log(`  SKIP title-mismatch ${c.asin} (${(overlap / Math.max(pw.size, 1)).toFixed(2)})\n    pool: ${decode(c.title).slice(0, 70)}\n    live: ${liveTitle.slice(0, 70)}`); continue
  }
  const availIdx = html.search(/id="availability"/)
  const availScope = availIdx >= 0 ? html.slice(Math.max(0, availIdx - 2000), availIdx + 5000) : ''
  if (/Currently unavailable|temporarily out of stock|We don't know when or if/i.test(availScope)) {
    if (APPLY) await sql(`UPDATE product_source_items SET active = FALSE, source_quality = 'stale' WHERE asin = $1`, [c.asin])
    skipped++; console.log(`  SKIP explicit-oos ${c.asin}`); continue
  }
  if (!/id="add-to-cart-button"|id="buy-now-button"/i.test(html)) { skipped++; console.log(`  SKIP no-buybox ${c.asin}`); continue }
  const coreIdx = html.search(/id="corePrice|id="apex_desktop/)
  const priceScope = coreIdx >= 0 ? html.slice(coreIdx, coreIdx + 25000) : html
  let amz = 0
  for (const p of [/"priceAmount":([0-9.]+)/, /class="a-price-whole">([\d,]+)/]) {
    const m = priceScope.match(p); if (m) { amz = parseFloat(m[1].replace(/,/g, '')); if (amz > 0) break }
  }
  if (!(amz > 0)) { skipped++; console.log(`  SKIP no-price ${c.asin}`); continue }
  // fast fulfillment: ships-from-Amazon or delivery <= 4 days — EXPLICIT only.
  // Look in the tabular buy box (modern layout) AND the availability/delivery blocks.
  const tabIdx = html.search(/id="tabular-buybox|id="deliveryBlockMessage|data-csa-c-delivery/)
  const shipScope = (tabIdx >= 0 ? html.slice(tabIdx, tabIdx + 12000) : '') + availScope
  const shipsAmazon = /Ships from\s*(?:<[^>]+>\s*)*Amazon(?:\.com)?\s*</i.test(shipScope) || /"shipsFrom"[^}]*Amazon/i.test(html)
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
  const dm = shipScope.match(/deliver[a-z]*\s+(?:[A-Za-z]+day,?\s+)?([A-Z][a-z]+)\s+(\d{1,2})/i) || html.match(/data-csa-c-delivery-time="[^"]*?([A-Z][a-z]+)\s+(\d{1,2})/)
  let deliveryDays = null
  if (dm) {
    const mi = months.indexOf(dm[1].toLowerCase())
    if (mi >= 0) {
      const now = new Date()
      let d = new Date(now.getFullYear(), mi, Number(dm[2]))
      if (d < now && now - d > 45 * 86400000) d = new Date(now.getFullYear() + 1, mi, Number(dm[2]))
      deliveryDays = Math.round((d - now) / 86400000)
    }
  }
  if (!(shipsAmazon || (deliveryDays !== null && deliveryDays <= 4))) { skipped++; console.log(`  SKIP slow-fulfillment ${c.asin} (shipsAmazon=${shipsAmazon}, days=${deliveryDays})`); continue }
  // images
  const imgs = [...new Set([...html.matchAll(/"hiRes":"(https:[^"]+?)"/g)].map(m => m[1]))].slice(0, 8)
  if (imgs.length < 2) { skipped++; console.log(`  SKIP images=${imgs.length} ${c.asin}`); continue }
  // price: keep pool eBay price if it still clears floor+ROI at fresh cost, else recompute
  let ebayPrice = c.pool_ebay
  if (!(net(ebayPrice, amz) >= FLOOR && net(ebayPrice, amz) / (amz * TAX) >= MIN_ROI)) {
    const needed = Math.max(FLOOR, MIN_ROI * amz * TAX)
    ebayPrice = Math.ceil(((amz * TAX + 0.40 + needed) / (1 - FEE - AD - BUF)) * 2) / 2 - 0.01
  }
  if (!(net(ebayPrice, amz) >= FLOOR - 0.01)) { skipped++; continue }

  const title = decode(c.title).slice(0, 80)
  console.log(`  PASS  $${amz} -> $${ebayPrice}  net $${net(ebayPrice, amz).toFixed(2)}  ${title.slice(0, 50)}`)
  if (!APPLY) { listed++; continue }

  // category via the Taxonomy API (the legacy GetSuggestedCategories endpoint is flaky)
  let categoryId = ''
  try {
    const q = encodeURIComponent(title.slice(0, 120))
    const catRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${q}`, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(15000),
    })
    if (catRes.ok) {
      const cd = await catRes.json()
      categoryId = String(cd?.categorySuggestions?.[0]?.category?.categoryId || '')
    }
  } catch { /* fall through */ }
  if (!categoryId) { skipped++; console.log(`  SKIP no-category ${c.asin}`); continue }
  // Ask eBay which aspects this category REQUIRES so the add can't bounce.
  let requiredAspects = []
  let categoryName = ''
  try {
    const aRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    })
    if (aRes.ok) {
      const ad = await aRes.json()
      requiredAspects = (ad?.aspects || []).filter(a => a?.aspectConstraint?.aspectRequired).map(a => a.localizedAspectName)
    }
    const nRes = await fetch(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_subtree?category_id=${categoryId}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    }).catch(() => null)
    if (nRes?.ok) categoryName = String((await nRes.json())?.categorySubtreeNode?.category?.categoryName || '')
  } catch { /* aspects best-effort; eBay will tell us if something is missing */ }

  const bullets = [...html.matchAll(/<span class="a-list-item(?:[^"]*)">\s*([^<]{20,300})</g)].map(m => decode(m[1])).filter(b => !/click here|warranty|customer/i.test(b)).slice(0, 5)
  const description = `<div style="font-family:Arial,sans-serif;max-width:800px"><h2>${xmlEsc(title)}</h2><ul>${bullets.map(b => `<li>${xmlEsc(b)}</li>`).join('')}</ul><p>&#10004; Brand new &nbsp;&#10004; FREE fast shipping &nbsp;&#10004; 30-day returns &nbsp;&#10004; Ships from USA</p></div>`
  const pictureXml = imgs.map(u => `<PictureURL>${xmlEsc(u)}</PictureURL>`).join('')
  const addXml = `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>
  <Item>
    <Title>${xmlEsc(title)}</Title>
    <Description><![CDATA[${description}]]></Description>
    <PrimaryCategory><CategoryID>${categoryId}</CategoryID></PrimaryCategory>
    <StartPrice>${ebayPrice.toFixed(2)}</StartPrice>
    <ConditionID>1000</ConditionID><Country>US</Country><Currency>USD</Currency>
    <DispatchTimeMax>2</DispatchTimeMax><ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType><Location>United States</Location>
    <PictureDetails>${pictureXml}</PictureDetails><Quantity>1</Quantity>
    <ItemSpecifics>${(() => {
      const specs = new Map()
      specs.set('Brand', (html.match(/Visit the ([^<]{2,40}) Store/)?.[1] || 'Unbranded').trim())
      // Amazon's product-overview table carries the variant's real attributes.
      for (const m of html.matchAll(/po-([a-z_.]+)[^>]*>[\s\S]{0,400}?class="a-size-base po-break-word"[^>]*>\s*([^<]{1,60})/g)) {
        const key = m[1].replace(/[_.]/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()).trim()
        const val = decode(m[2])
        if (val && ['Color', 'Size', 'Material', 'Style', 'Pattern'].includes(key)) specs.set(key, val)
      }
      if (!specs.has('Color')) specs.set('Color', 'Multicolor')
      if (/women'?s/i.test(title)) specs.set('Department', 'Women')
      else if (/men'?s/i.test(title)) specs.set('Department', 'Men')
      if (/shirt|hoodie|top|tee|pant|short|sock|glove|hat|wristband|apparel/i.test(title) && !specs.has('Size')) specs.set('Size', 'One Size')
      // Fill every aspect eBay marked REQUIRED for this category.
      for (const name of requiredAspects) {
        if (specs.has(name)) continue
        if (name === 'Type') specs.set(name, (categoryName || title.split(' ').slice(-2).join(' ')).replace(/s$/, '').slice(0, 50) || 'Standard')
        else if (name === 'Size Type') specs.set(name, 'Regular')
        else if (name === 'Sleeve Length') specs.set(name, /long sleeve/i.test(title) ? 'Long Sleeve' : 'Short Sleeve')
        else if (name === 'Style') specs.set(name, 'Casual')
        else if (name === 'Model') specs.set(name, c.asin)
        else specs.set(name, 'Does Not Apply')
      }
      return [...specs].map(([n, v]) => `<NameValueList><Name>${xmlEsc(n)}</Name><Value>${xmlEsc(v.slice(0, 60))}</Value></NameValueList>`).join('')
    })()}</ItemSpecifics>
    <ReturnPolicy><ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption><RefundOption>MoneyBack</RefundOption><ReturnsWithinOption>Days_30</ReturnsWithinOption><ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption></ReturnPolicy>
    <ShippingDetails><ShippingType>Flat</ShippingType><ShippingServiceOptions><ShippingServicePriority>1</ShippingServicePriority><ShippingService>ShippingMethodStandard</ShippingService><ShippingServiceCost>0.00</ShippingServiceCost></ShippingServiceOptions>
      <ExcludeShipToLocation>Alaska/Hawaii</ExcludeShipToLocation><ExcludeShipToLocation>APO/FPO</ExcludeShipToLocation><ExcludeShipToLocation>PO Box</ExcludeShipToLocation><ExcludeShipToLocation>US Protectorates</ExcludeShipToLocation>
    </ShippingDetails><Site>US</Site>
  </Item>
</AddFixedPriceItemRequest>`
  const addRes = await ebayCall('AddFixedPriceItem', addXml)
  const ack = addRes.match(/<Ack>(.*?)<\/Ack>/)?.[1]
  const itemId = addRes.match(/<ItemID>(\d+)<\/ItemID>/)?.[1]
  if ((ack === 'Success' || ack === 'Warning') && itemId) {
    listed++
    await sql(`
      INSERT INTO listed_asins (user_id, asin, title, ebay_listing_id, amazon_price, amazon_verified_price, ebay_price, ebay_fee_rate, amazon_image_url, amazon_images, amazon_snapshot, niche, category_id, amazon_available, amazon_status_reason, amazon_status_checked_at, amazon_price_verified_at, amazon_price_verification_source, amazon_fast_fulfillment, amazon_fulfillment_verified_at, image_count, listed_at)
      VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,'available',NOW(),NOW(),'amazon_buy_box',TRUE,NOW(),$13,NOW())
      ON CONFLICT (user_id, asin) DO UPDATE SET
        ebay_listing_id=$4, title=$3, amazon_price=$5, amazon_verified_price=$5, ebay_price=$6,
        amazon_image_url=$8, amazon_images=$9, amazon_available=TRUE, amazon_status_reason='available',
        amazon_status_checked_at=NOW(), amazon_price_verified_at=NOW(), amazon_price_verification_source='amazon_buy_box',
        amazon_fast_fulfillment=TRUE, amazon_fulfillment_verified_at=NOW(), image_count=$13, listed_at=NOW(), ended_at=NULL
    `, [USER_ID, c.asin, title.slice(0, 200), itemId, amz.toFixed(2), ebayPrice.toFixed(2), FEE, imgs[0], JSON.stringify(imgs), JSON.stringify({ asin: c.asin, title, amazonPrice: amz, source: 'local-lister', amazonUrl: `https://www.amazon.com/dp/${c.asin}` }), c.source_niche, categoryId, imgs.length])
    receipts.push({ at: new Date().toISOString(), asin: c.asin, itemId, ebayPrice, amz, title: title.slice(0, 60) })
    console.log(`  LISTED  https://www.ebay.com/itm/${itemId}`)
  } else {
    skipped++
    const err = addRes.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] || ''
    if (/duplicate|already/i.test(err)) { /* leave pool item; publish-gate parity */ }
    console.log(`  EBAY-FAIL  ${err.slice(0, 100)}`)
    if (/exceeded usage limit/i.test(addRes)) break
  }
}
fs.mkdirSync(path.resolve('scripts/receipts'), { recursive: true })
if (receipts.length) fs.appendFileSync(path.resolve('scripts/receipts/local-lister.jsonl'), receipts.map(x => JSON.stringify(x)).join('\n') + '\n')
console.log(`\nDONE: ${listed} ${APPLY ? 'listed' : 'would list'}, ${skipped} skipped by gates`)
