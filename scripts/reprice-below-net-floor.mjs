import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'
import path from 'node:path'

const env = Object.fromEntries(
  fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=')
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^"|"$/g, '')]
    }),
)

const sql = neon(env.DATABASE_URL)
const apply = process.argv.includes('--apply')
const USER_ID = Number(process.argv.find((arg) => arg.startsWith('--userId='))?.split('=')[1] || 1)
const LIMIT = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 300)
const MIN_NET_PROFIT = Number(env.MIN_NET_PROFIT || '5')
const EBAY_FEE_RATE = Number(env.EBAY_FEE_RATE || '0.136')
const PROMOTED_AD_RATE = Number(env.PROMOTED_AD_RATE || '0.06')
const AMAZON_SOURCE_TAX_RATE = Number(env.AMAZON_SOURCE_TAX_RATE || '0.07')
const PRICING_BUFFER_RATE = Number(env.PRICING_BUFFER_RATE || '0.015')

function escapeXml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fixedFee(ebayPrice) {
  return ebayPrice > 0 && ebayPrice <= 10 ? 0.3 : 0.4
}

function netProfit(amazonPrice, ebayPrice) {
  return Number((
    ebayPrice -
    amazonPrice * (1 + AMAZON_SOURCE_TAX_RATE) -
    ebayPrice * EBAY_FEE_RATE -
    fixedFee(ebayPrice) -
    ebayPrice * PRICING_BUFFER_RATE -
    ebayPrice * PROMOTED_AD_RATE
  ).toFixed(2))
}

function priceForNetProfit(amazonPrice) {
  const variableRate = EBAY_FEE_RATE + PROMOTED_AD_RATE + PRICING_BUFFER_RATE
  const lowPass = (amazonPrice * (1 + AMAZON_SOURCE_TAX_RATE) + 0.3 + MIN_NET_PROFIT) / (1 - variableRate)
  const raw = lowPass <= 10
    ? lowPass
    : (amazonPrice * (1 + AMAZON_SOURCE_TAX_RATE) + 0.4 + MIN_NET_PROFIT) / (1 - variableRate)
  let price = Math.floor(raw) + 0.99
  if (price < raw) price += 1
  return Number(price.toFixed(2))
}

async function refreshTokenIfNeeded(row) {
  const token = String(row?.oauth_token || '')
  const expiresAt = row?.token_expires_at ? new Date(row.token_expires_at) : null
  if (token && expiresAt && expiresAt.getTime() > Date.now() + 5 * 60 * 1000) return token
  if (!row?.refresh_token || !env.EBAY_APP_ID || !env.EBAY_CERT_ID) return token

  const credentials = Buffer.from(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`).toString('base64')
  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
      scope: [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
      ].join(' '),
    }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.access_token) return token
  const tokenExpiresAt = new Date(Date.now() + Number(data.expires_in || 7200) * 1000).toISOString()
  await sql`
    UPDATE ebay_credentials
    SET oauth_token = ${data.access_token}, token_expires_at = ${tokenExpiresAt}, updated_at = NOW()
    WHERE user_id = ${USER_ID}
  `.catch(() => {})
  return data.access_token
}

async function getToken() {
  const [row] = await sql`
    SELECT oauth_token, refresh_token, token_expires_at
    FROM ebay_credentials
    WHERE user_id = ${USER_ID}
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `
  if (!row) throw new Error(`No ebay_credentials row for user ${USER_ID}`)
  return refreshTokenIfNeeded(row)
}

async function revisePrice(token, listingId, price) {
  const fixedPriceXml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(token)}</eBayAuthToken></RequesterCredentials>
  <Item>
    <ItemID>${escapeXml(listingId)}</ItemID>
    <StartPrice>${price.toFixed(2)}</StartPrice>
  </Item>
</ReviseFixedPriceItemRequest>`

  const fixedPriceResponse = await callTradingApi(token, 'ReviseFixedPriceItem', fixedPriceXml)
  if (fixedPriceResponse.ok) return fixedPriceResponse

  const inventoryXml = `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(token)}</eBayAuthToken></RequesterCredentials>
  <InventoryStatus>
    <ItemID>${escapeXml(listingId)}</ItemID>
    <StartPrice>${price.toFixed(2)}</StartPrice>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`

  const inventoryResponse = await callTradingApi(token, 'ReviseInventoryStatus', inventoryXml)
  if (inventoryResponse.ok) return inventoryResponse

  return {
    ok: false,
    status: inventoryResponse.status,
    text: `${fixedPriceResponse.text}\n--- ReviseInventoryStatus fallback ---\n${inventoryResponse.text}`,
  }
}

async function callTradingApi(token, callName, xml) {
  const response = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-APP-NAME': env.EBAY_APP_ID || '',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/xml',
    },
    body: xml,
  })
  const text = await response.text()
  return {
    ok: /<Ack>(Success|Warning)<\/Ack>/i.test(text),
    status: response.status,
    text,
  }
}

await sql`
  CREATE TABLE IF NOT EXISTS reprice_agent_log (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    ebay_listing_id TEXT NOT NULL,
    asin TEXT,
    old_ebay_price NUMERIC(10,2),
    new_ebay_price NUMERIC(10,2),
    old_amazon_price NUMERIC(10,2),
    new_amazon_price NUMERIC(10,2),
    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`.catch(() => {})

const rows = await sql`
  SELECT user_id, ebay_listing_id, asin, title, amazon_price, ebay_price
  FROM listed_asins
  WHERE user_id = ${USER_ID}
    AND ended_at IS NULL
    AND ebay_listing_id IS NOT NULL
    AND amazon_price IS NOT NULL
    AND ebay_price IS NOT NULL
    AND amazon_price > 0
    AND ebay_price > 0
  ORDER BY listed_at ASC
`

const candidates = rows
  .map((row) => {
    const amazonPrice = Number(row.amazon_price || 0)
    const oldPrice = Number(row.ebay_price || 0)
    const currentNet = netProfit(amazonPrice, oldPrice)
    const newPrice = priceForNetProfit(amazonPrice)
    const newNet = netProfit(amazonPrice, newPrice)
    return { ...row, amazonPrice, oldPrice, currentNet, newPrice, newNet }
  })
  .filter((row) => row.currentNet < MIN_NET_PROFIT && row.newPrice > row.oldPrice + 0.01)
  .sort((a, b) => a.currentNet - b.currentNet)
  .slice(0, LIMIT)

console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${candidates.length} active listings below $${MIN_NET_PROFIT.toFixed(2)} true-net floor`)
for (const row of candidates.slice(0, 20)) {
  console.log(`${row.ebay_listing_id} ${row.asin || ''} $${row.oldPrice.toFixed(2)} -> $${row.newPrice.toFixed(2)} | net $${row.currentNet.toFixed(2)} -> $${row.newNet.toFixed(2)} | ${String(row.title || '').slice(0, 70)}`)
}

if (!apply || candidates.length === 0) process.exit(0)

const token = await getToken()
if (!token) throw new Error('No usable eBay token.')

let revised = 0
let failed = 0
for (const row of candidates) {
  const result = await revisePrice(token, String(row.ebay_listing_id), row.newPrice)
  if (result.ok) {
    revised++
    await sql`
      UPDATE listed_asins
      SET ebay_price = ${row.newPrice},
          last_repriced_at = NOW()
      WHERE user_id = ${USER_ID}
        AND ebay_listing_id = ${row.ebay_listing_id}
    `.catch(() => {})
    await sql`
      INSERT INTO reprice_agent_log (
        user_id, ebay_listing_id, asin,
        old_ebay_price, new_ebay_price,
        old_amazon_price, new_amazon_price,
        dry_run, success
      )
      VALUES (
        ${USER_ID}, ${row.ebay_listing_id}, ${row.asin},
        ${row.oldPrice}, ${row.newPrice},
        ${row.amazonPrice}, ${row.amazonPrice},
        FALSE, TRUE
      )
    `.catch(() => {})
  } else {
    failed++
    console.log(`FAILED ${row.ebay_listing_id}: ${result.status} ${result.text.slice(0, 240)}`)
  }
  await new Promise((resolve) => setTimeout(resolve, 180))
}

console.log(`Done. revised=${revised} failed=${failed}`)
