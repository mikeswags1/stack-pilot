#!/usr/bin/env node

/**
 * Repair literal HTML-entity residue in live eBay titles.
 *
 * Safety properties:
 *   - Preview/read-only by default. Listing and DB writes require explicit --apply.
 *   - Candidates come from a complete live GetMyeBaySelling scan, not listed_asins.title.
 *   - The repair only decodes recognized entities; it never changes a legitimate bare `&`.
 *   - ReviseFixedPriceItem sends ItemID + Title only. No price, quantity, image, SEO, or
 *     brand fields are touched.
 *   - listed_asins.title is updated only after eBay returns Ack=Success or Ack=Warning.
 *   - Apply mode finishes with another complete live scan and exits nonzero if any
 *     malformed title remains.
 *
 * Usage:
 *   node scripts/repair-encoded-ebay-titles.mjs
 *   node scripts/repair-encoded-ebay-titles.mjs --user=1
 *   node scripts/repair-encoded-ebay-titles.mjs --user=1 --apply
 *   node scripts/repair-encoded-ebay-titles.mjs --all-users --apply
 */

import { neon } from '@neondatabase/serverless'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'

const ENTRIES_PER_PAGE = 200
const MAX_PAGES_PER_ACCOUNT = 100
const SCAN_CONCURRENCY = 4
const REVISION_DELAY_MS = 100
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000
const MIN_EBAY_PICTURE_SIDE = 500
const MIN_REMEDIATED_PICTURES = 2
const MAX_STORED_IMAGE_CANDIDATES = 40
const IMAGE_MATCH_MAX_DISTANCE = 160
const IMAGE_MATCH_MAX_MAE = 18
const IMAGE_VERIFY_MAX_DISTANCE = 220
const IMAGE_VERIFY_MAX_MAE = 28
const DEFAULT_PROXY_ORIGIN = 'https://stackpilot-app.vercel.app'

function usage() {
  console.log(`Usage: node scripts/repair-encoded-ebay-titles.mjs [--user=<id>] [--all-users] [--apply]
       node scripts/repair-encoded-ebay-titles.mjs --user=<id> --item=<ebay-id> --repair-pictures [--apply]

Default mode is a live, read-only preview. No listing or database title is changed
unless --apply is present. --user limits the scan to one StackPilot user; otherwise
every active row in ebay_accounts is previewed. Apply mode requires either an explicit
--user=<id> scope or the explicit --all-users acknowledgement.

Picture remediation is deliberately item-scoped and opt-in. It requires --user,
--item, and --repair-pictures. Preview validates the complete current eBay picture
list plus same-host production proxy output. --apply revises only that one item and
then re-reads it from eBay to verify title, picture count/order/content, and size.`)
}

function parseArgs(argv) {
  let apply = false
  let allUsers = false
  let userId = null
  let itemId = null
  let repairPictures = false

  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--all-users') {
      allUsers = true
      continue
    }
    if (arg === '--repair-pictures') {
      repairPictures = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
    if (arg.startsWith('--user=')) {
      const value = Number(arg.slice('--user='.length))
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid --user value: ${arg}`)
      }
      userId = value
      continue
    }
    if (arg.startsWith('--item=')) {
      const value = arg.slice('--item='.length).trim()
      if (!/^\d{9,20}$/.test(value)) throw new Error(`Invalid --item value: ${arg}`)
      itemId = value
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (allUsers && userId !== null) throw new Error('Choose either --user=<id> or --all-users, not both.')
  if (itemId && !repairPictures) {
    throw new Error('--item requires --repair-pictures.')
  }
  if (repairPictures && (userId === null || allUsers)) {
    throw new Error('Picture remediation requires one explicit --user=<id>; --all-users is never allowed.')
  }
  if (apply && userId === null && !allUsers) {
    throw new Error('Apply mode requires --user=<id>. Use --all-users only when intentionally repairing every active account.')
  }

  return { apply, allUsers, userId, itemId, repairPictures }
}

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(envPath)) return

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

const {
  apply: APPLY,
  allUsers: ALL_USERS,
  userId: USER_ID,
  itemId: ITEM_ID,
  repairPictures: REPAIR_PICTURES,
} = parseArgs(process.argv.slice(2))
loadLocalEnv()

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.')
if (!process.env.EBAY_APP_ID) throw new Error('EBAY_APP_ID is not configured.')

const sql = neon(process.env.DATABASE_URL)

// Keep this detector/decoder equivalent to lib/html-entities.ts. It recognizes encoded
// residue only; a normal title such as "Home & Garden" is deliberately not a candidate.
const NAMED_HTML_ENTITIES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

const TITLE_ENTITY_ARTIFACT =
  /&(?:amp;)*(?:#(?:x[0-9a-f]{1,6}|[0-9]{1,7});?|(?:amp|apos|gt|lt|nbsp|quot);)/i

function validCodePoint(codePoint) {
  return Number.isFinite(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff)
}

function decodeNumericEntity(match, hexValue, decimalValue) {
  const codePoint = Number.parseInt(hexValue || decimalValue || '', hexValue ? 16 : 10)
  if (!validCodePoint(codePoint)) return match
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return match
  }
}

function decodeHtmlEntityPass(value) {
  return value
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi, decodeNumericEntity)
    .replace(/&(amp|apos|gt|lt|nbsp|quot);/gi, (match, name) => (
      NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match
    ))
}

function decodeHtmlEntitiesDeep(value, maxPasses = 4) {
  let decoded = String(value || '')
  for (let pass = 0; pass < Math.max(1, Math.min(8, maxPasses)); pass += 1) {
    const next = decodeHtmlEntityPass(decoded)
    if (next === decoded) break
    decoded = next
  }
  return decoded
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
}

function hasEncodedTitleArtifact(value) {
  return TITLE_ENTITY_ARTIFACT.test(String(value || ''))
}

function repairEncodedEbayTitle(value) {
  return decodeHtmlEntitiesDeep(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Decode exactly one XML transport layer. Numeric/name entities run before &amp; so an
// entity literally stored in the eBay title stays visible for the deep repair step.
function decodeXmlLayer(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => {
      const codePoint = Number.parseInt(hex, 16)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    })
    .replace(/&#([0-9]{1,7});/g, (match, decimal) => {
      const codePoint = Number.parseInt(decimal, 10)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function tag(block, name) {
  const match = String(block || '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match?.[1] ? decodeXmlLayer(match[1].trim()) : ''
}

function tags(block, name) {
  return [...String(block || '').matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi'))]
    .map((match) => decodeXmlLayer(String(match[1] || '').trim()))
    .filter(Boolean)
}

function ebayError(text) {
  return {
    code: tag(text, 'ErrorCode') || '',
    message: tag(text, 'LongMessage') || tag(text, 'ShortMessage') || 'Unknown eBay error.',
  }
}

function tradingEndpoint(account) {
  return account.sandboxMode
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'
}

function identityEndpoint(account) {
  return account.sandboxMode
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token'
}

let usageLoggingAvailable = APPLY
async function logApiCall({ account, callName, success, durationMs, errorCode, errorMessage }) {
  if (!usageLoggingAvailable) return
  try {
    await sql(`
      INSERT INTO api_usage_log
        (provider, call_name, user_id, success, duration_ms, error_code, error_message)
      VALUES ('ebay', $1, $2, $3, $4, $5, $6)
    `, [
      String(callName).slice(0, 60),
      Number(account.userId),
      Boolean(success),
      Number.isFinite(durationMs) ? Math.round(durationMs) : null,
      errorCode ? String(errorCode).slice(0, 60) : null,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
    ])
  } catch (error) {
    usageLoggingAvailable = false
    console.warn(`Warning: API usage logging is unavailable: ${String(error?.message || error)}`)
  }
}

async function refreshAccessToken(account, force = false) {
  const expiresAt = new Date(account.tokenExpiresAt || 0).getTime()
  if (!force && account.accessToken && Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return
  }
  if (!account.refreshToken) {
    throw new Error(`${account.display}: eBay access token is expired and no refresh token is stored.`)
  }
  if (!process.env.EBAY_CERT_ID) {
    throw new Error(`${account.display}: EBAY_CERT_ID is required to refresh the eBay access token.`)
  }

  const startedAt = Date.now()
  const basic = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64')
  let response
  let data
  try {
    response = await fetch(identityEndpoint(account), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        scope: 'https://api.ebay.com/oauth/api_scope',
      }),
      signal: AbortSignal.timeout(20_000),
    })
    data = await response.json().catch(() => null)
  } catch (error) {
    await logApiCall({
      account,
      callName: 'OAuthRefresh',
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: 'NETWORK',
      errorMessage: String(error?.message || error),
    })
    throw new Error(`${account.display}: eBay token refresh did not respond.`)
  }

  const ok = response.ok && data?.access_token
  await logApiCall({
    account,
    callName: 'OAuthRefresh',
    success: Boolean(ok),
    durationMs: Date.now() - startedAt,
    errorCode: ok ? null : `HTTP_${response.status}`,
    errorMessage: ok ? null : String(data?.error_description || data?.error || 'Token refresh failed.'),
  })
  if (!ok) {
    throw new Error(`${account.display}: eBay token refresh failed; reconnect the account in Settings.`)
  }

  account.accessToken = String(data.access_token)
  account.tokenExpiresAt = new Date(Date.now() + Number(data.expires_in || 7200) * 1000).toISOString()
}

async function tradingCall(account, callName, xml, { allowAuthRetry = true, timeoutMs = 30_000 } = {}) {
  await refreshAccessToken(account)
  const startedAt = Date.now()
  let response
  let text
  try {
    response = await fetch(tradingEndpoint(account), {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': callName,
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
        'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID,
        'Content-Type': 'text/xml',
      },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await response.text()
  } catch (error) {
    await logApiCall({
      account,
      callName,
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: 'NETWORK',
      errorMessage: String(error?.message || error),
    })
    throw new Error(`${account.display}: ${callName} did not respond; outcome is unknown.`)
  }

  const acknowledged = /<Ack>(Success|Warning)<\/Ack>/i.test(text)
  const detail = acknowledged ? { code: '', message: '' } : ebayError(text)
  const ok = response.ok && acknowledged
  await logApiCall({
    account,
    callName,
    success: ok,
    durationMs: Date.now() - startedAt,
    errorCode: ok ? null : detail.code || `HTTP_${response.status}`,
    errorMessage: ok ? null : detail.message,
  })

  const authFailure = !ok && /token|auth|credential|931|932|16110/i.test(`${detail.code} ${detail.message}`)
  if (allowAuthRetry && authFailure && account.refreshToken) {
    await refreshAccessToken(account, true)
    return tradingCall(account, callName, xml.replace(
      /<eBayAuthToken>[\s\S]*?<\/eBayAuthToken>/i,
      `<eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken>`,
    ), { allowAuthRetry: false, timeoutMs })
  }

  return { ok, acknowledged, status: response.status, text, detail }
}

function getPictureProxyOrigin() {
  const configured = String(process.env.STACKPILOT_IMAGE_PROXY_ORIGIN || DEFAULT_PROXY_ORIGIN).trim().replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(configured)
  } catch {
    throw new Error(`Invalid STACKPILOT_IMAGE_PROXY_ORIGIN: ${configured}`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/') {
    throw new Error('Picture proxy origin must be a bare HTTPS origin with no credentials or path.')
  }
  return parsed.origin
}

function ebayDeclaredPictureDimensions(url) {
  try {
    const encoded = String(url || '').match(/\/s\/([^/]+)\//i)?.[1]
    if (!encoded) return null
    const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const match = decoded.match(/^(\d+)X(\d+)$/i)
    if (!match) return null
    const height = Number(match[1])
    const width = Number(match[2])
    return { width, height, longest: Math.max(width, height) }
  } catch {
    return null
  }
}

function getItemXml(account, ebayListingId) {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ItemID>${escapeXml(ebayListingId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>`
}

async function getItemDetails(account, ebayListingId) {
  const result = await tradingCall(account, 'GetItem', getItemXml(account, ebayListingId))
  if (!result.ok) {
    throw new Error(`${account.display}: GetItem ${ebayListingId} failed: ${result.detail.message}`)
  }
  const itemBlock = result.text.match(/<Item>([\s\S]*?)<\/Item>/i)?.[1]
  if (!itemBlock) throw new Error(`${account.display}: GetItem ${ebayListingId} omitted Item.`)

  const pictures = tags(itemBlock, 'PictureURL')
  return {
    ebayListingId: tag(itemBlock, 'ItemID') || ebayListingId,
    title: tag(itemBlock, 'Title'),
    categoryId: tag(itemBlock, 'CategoryID'),
    categoryName: tag(itemBlock, 'CategoryName'),
    pictures,
    pictureDimensions: pictures.map(ebayDeclaredPictureDimensions),
    hasVariations: /<Variations(?:\s|>)/i.test(itemBlock),
  }
}

function isCoinCategory(item) {
  return /\bcoins?\b/i.test(`${item.categoryName || ''} ${item.categoryId || ''}`)
}

function normalizeImageArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string')
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

function amazonOriginalImageUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    if (!/(?:^|\.)media-amazon\.com$/i.test(parsed.hostname) && !/(?:^|\.)images-amazon\.com$/i.test(parsed.hostname)) {
      return raw
    }
  } catch {
    return raw
  }
  return raw.replace(/\._[^/]*?(?=\.(?:jpe?g|png|webp)(?:$|\?))/i, '')
}

function amazonImageKey(value) {
  const match = String(value || '').match(/\/images\/I\/([^./?]+)/i)
  return match?.[1] || ''
}

function isAllowedStoredAmazonImage(value) {
  try {
    const parsed = new URL(String(value || ''))
    return parsed.protocol === 'https:' && (
      /(?:^|\.)media-amazon\.com$/i.test(parsed.hostname) ||
      /(?:^|\.)images-amazon\.com$/i.test(parsed.hostname) ||
      /(?:^|\.)ssl-images-amazon\.com$/i.test(parsed.hostname)
    )
  } catch {
    return false
  }
}

async function loadExactAsinImageSources(candidate) {
  const rows = await sql(`
    SELECT
      l.asin,
      l.amazon_image_url,
      l.amazon_images,
      l.amazon_snapshot,
      c.primary_image AS cache_primary_image,
      c.images AS cache_images
    FROM listed_asins l
    LEFT JOIN amazon_product_cache c ON c.asin = l.asin
    WHERE l.user_id = $1
      AND l.ebay_listing_id = $2
      AND l.ended_at IS NULL
    LIMIT 1
  `, [Number(candidate.userId), candidate.ebayListingId])

  const row = rows[0]
  if (!row?.asin) return { asin: null, urls: [] }
  const snapshot = row.amazon_snapshot && typeof row.amazon_snapshot === 'object' ? row.amazon_snapshot : {}
  const rawUrls = [
    row.amazon_image_url,
    ...normalizeImageArray(row.amazon_images),
    snapshot.imageUrl,
    ...normalizeImageArray(snapshot.images),
    row.cache_primary_image,
    ...normalizeImageArray(row.cache_images),
  ].filter(isAllowedStoredAmazonImage)

  const urls = []
  const seen = new Set()
  for (const rawUrl of rawUrls) {
    for (const url of [String(rawUrl), amazonOriginalImageUrl(rawUrl)]) {
      if (!url || seen.has(url) || !isAllowedStoredAmazonImage(url)) continue
      seen.add(url)
      urls.push(url)
      if (urls.length >= MAX_STORED_IMAGE_CANDIDATES) break
    }
    if (urls.length >= MAX_STORED_IMAGE_CANDIDATES) break
  }
  return { asin: String(row.asin), urls }
}

async function mapLimit(values, limit, worker) {
  const output = Array(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      output[index] = await worker(values[index], index)
    }
  }))
  return output
}

async function fetchImageProbe(url) {
  let response
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(25_000),
    })
  } catch (error) {
    throw new Error(`Image did not respond: ${url} (${String(error?.message || error)})`)
  }
  if (!response.ok) throw new Error(`Image returned HTTP ${response.status}: ${url}`)
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (!contentType.startsWith('image/')) throw new Error(`URL did not return an image: ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) {
    throw new Error(`Image byte size is unsafe (${buffer.length}): ${url}`)
  }

  let metadata
  let pixels
  try {
    metadata = await sharp(buffer).metadata()
    pixels = await sharp(buffer)
      .rotate()
      .resize(32, 32, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .greyscale()
      .raw()
      .toBuffer()
  } catch {
    throw new Error(`Image could not be decoded: ${url}`)
  }
  const width = Number(metadata.width || 0)
  const height = Number(metadata.height || 0)
  const mean = [...pixels].reduce((sum, value) => sum + value, 0) / pixels.length
  const hash = [...pixels].map((value) => value >= mean ? 1 : 0)
  return { url, width, height, longest: Math.max(width, height), pixels, hash }
}

function imageDistance(left, right) {
  if (!left?.pixels || !right?.pixels || left.pixels.length !== right.pixels.length) {
    return { hamming: Number.POSITIVE_INFINITY, mae: Number.POSITIVE_INFINITY }
  }
  let hamming = 0
  let absoluteError = 0
  for (let index = 0; index < left.pixels.length; index += 1) {
    if (left.hash[index] !== right.hash[index]) hamming += 1
    absoluteError += Math.abs(left.pixels[index] - right.pixels[index])
  }
  return { hamming, mae: absoluteError / left.pixels.length }
}

function isPerceptualMatch(distance, verify = false) {
  return distance.hamming <= (verify ? IMAGE_VERIFY_MAX_DISTANCE : IMAGE_MATCH_MAX_DISTANCE) &&
    distance.mae <= (verify ? IMAGE_VERIFY_MAX_MAE : IMAGE_MATCH_MAX_MAE)
}

function rankMatches(currentProbe, probes) {
  return probes
    .map((probe) => ({ probe, distance: imageDistance(currentProbe, probe) }))
    .sort((left, right) => left.distance.mae - right.distance.mae || left.distance.hamming - right.distance.hamming)
}

function chooseUpgradedStoredMatch(currentProbe, storedProbes) {
  const bestAny = rankMatches(currentProbe, storedProbes)[0]
  if (!bestAny || !isPerceptualMatch(bestAny.distance)) return null

  if (bestAny.probe.longest >= MIN_EBAY_PICTURE_SIDE) return bestAny

  const key = amazonImageKey(bestAny.probe.url)
  const sameImageHighResolution = key
    ? storedProbes
        .filter((probe) => amazonImageKey(probe.url) === key && probe.longest >= MIN_EBAY_PICTURE_SIDE)
        .map((probe) => ({ probe, distance: imageDistance(currentProbe, probe) }))
        .filter((entry) => isPerceptualMatch(entry.distance))
        .sort((left, right) => left.distance.mae - right.distance.mae || left.distance.hamming - right.distance.hamming)[0]
    : null
  if (sameImageHighResolution) return sameImageHighResolution

  return rankMatches(currentProbe, storedProbes.filter((probe) => probe.longest >= MIN_EBAY_PICTURE_SIDE))
    .find((entry) => isPerceptualMatch(entry.distance)) || null
}

function buildProxyUrl(origin, sourceUrl) {
  const url = new URL('/api/image/proxy', origin)
  url.searchParams.set('url', sourceUrl)
  if (url.origin !== origin || url.pathname !== '/api/image/proxy') {
    throw new Error('Generated picture proxy URL escaped the configured same-host endpoint.')
  }
  if (url.toString().length > 500) throw new Error(`Proxied PictureURL exceeds eBay's 500-character limit.`)
  return url.toString()
}

async function validateProxiedPicture(origin, sourceUrl, sourceProbe = null) {
  const inputProbe = sourceProbe || await fetchImageProbe(sourceUrl)
  const proxyUrl = buildProxyUrl(origin, sourceUrl)
  const parsed = new URL(proxyUrl)
  if (parsed.origin !== origin) throw new Error(`Picture proxy host mismatch for ${sourceUrl}`)
  const proxyProbe = await fetchImageProbe(proxyUrl)
  if (proxyProbe.longest < MIN_EBAY_PICTURE_SIDE) {
    throw new Error(`Proxy output is only ${proxyProbe.width}x${proxyProbe.height}: ${proxyUrl}`)
  }
  const distance = imageDistance(inputProbe, proxyProbe)
  if (!isPerceptualMatch(distance, true)) {
    throw new Error(`Proxy changed picture content (hamming ${distance.hamming}, MAE ${distance.mae.toFixed(2)}): ${sourceUrl}`)
  }
  return { sourceUrl, proxyUrl, sourceProbe: inputProbe, proxyProbe, distance }
}

async function buildPictureRepairPlan(candidate, accountListings) {
  const account = candidate.account
  const item = await getItemDetails(account, candidate.ebayListingId)
  if (item.ebayListingId !== candidate.ebayListingId || item.title !== candidate.title) {
    throw new Error(`${candidate.ebayListingId}: live item changed between the complete scan and GetItem; rerun preview.`)
  }
  if (item.hasVariations) throw new Error(`${candidate.ebayListingId}: variation listings are excluded from picture remediation.`)
  if (isCoinCategory(item)) throw new Error(`${candidate.ebayListingId}: coin categories are excluded from picture remediation.`)
  if (item.pictures.length < MIN_REMEDIATED_PICTURES) {
    throw new Error(`${candidate.ebayListingId}: only ${item.pictures.length} current pictures; refusing picture remediation.`)
  }
  if (item.pictureDimensions.some((dimensions) => !dimensions)) {
    throw new Error(`${candidate.ebayListingId}: eBay omitted original dimensions for at least one picture.`)
  }

  const duplicate = accountListings.find((listing) => (
    listing.ebayListingId !== candidate.ebayListingId &&
    repairEncodedEbayTitle(listing.title).toLowerCase() === candidate.newTitle.toLowerCase()
  ))
  if (duplicate) {
    throw new Error(`${candidate.ebayListingId}: repaired title collides with live item ${duplicate.ebayListingId}; duplicate cases are excluded.`)
  }

  const invalidIndexes = item.pictureDimensions
    .map((dimensions, index) => dimensions.longest < MIN_EBAY_PICTURE_SIDE ? index : -1)
    .filter((index) => index >= 0)
  if (invalidIndexes.length === 0) {
    throw new Error(`${candidate.ebayListingId}: no sub-${MIN_EBAY_PICTURE_SIDE}px current pictures; use normal title-only mode.`)
  }

  const validCurrentCount = item.pictures.length - invalidIndexes.length
  const stored = await loadExactAsinImageSources(candidate)
  const storedProbes = await mapLimit(stored.urls, 4, async (url) => {
    try {
      return await fetchImageProbe(url)
    } catch {
      return null
    }
  }).then((rows) => rows.filter(Boolean))

  const currentInvalidProbes = new Map()
  await mapLimit(invalidIndexes, 3, async (index) => {
    currentInvalidProbes.set(index, await fetchImageProbe(item.pictures[index]))
  })

  const entries = []
  const unmatched = []
  for (let index = 0; index < item.pictures.length; index += 1) {
    const currentUrl = item.pictures[index]
    const dimensions = item.pictureDimensions[index]
    if (dimensions.longest >= MIN_EBAY_PICTURE_SIDE) {
      entries.push({ index, action: 'preserve-via-proxy', currentUrl, sourceUrl: currentUrl, dimensions })
      continue
    }

    const currentProbe = currentInvalidProbes.get(index)
    const match = currentProbe ? chooseUpgradedStoredMatch(currentProbe, storedProbes) : null
    if (match) {
      entries.push({
        index,
        action: 'replace-from-exact-asin-source',
        currentUrl,
        sourceUrl: match.probe.url,
        sourceProbe: match.probe,
        dimensions,
        matchDistance: match.distance,
      })
    } else {
      unmatched.push({ index, currentUrl, dimensions })
    }
  }

  if (unmatched.length > 0 && validCurrentCount < MIN_REMEDIATED_PICTURES) {
    throw new Error(
      `${candidate.ebayListingId}: ${unmatched.length} low-resolution picture(s) had no perceptual exact-ASIN match and only ${validCurrentCount} compliant current picture(s) remain.`,
    )
  }
  for (const dropped of unmatched) entries.push({ ...dropped, action: 'drop-unmatched-low-resolution', sourceUrl: null })
  entries.sort((left, right) => left.index - right.index)

  const submittedEntries = entries.filter((entry) => entry.sourceUrl)
  if (submittedEntries.length < MIN_REMEDIATED_PICTURES) {
    throw new Error(`${candidate.ebayListingId}: remediation would leave fewer than ${MIN_REMEDIATED_PICTURES} pictures.`)
  }

  const origin = getPictureProxyOrigin()
  const validated = await mapLimit(submittedEntries, 2, async (entry) => ({
    ...entry,
    ...(await validateProxiedPicture(origin, entry.sourceUrl, entry.sourceProbe || null)),
  }))
  const proxyOrigins = new Set(validated.map((entry) => new URL(entry.proxyUrl).origin))
  if (proxyOrigins.size !== 1 || !proxyOrigins.has(origin)) {
    throw new Error(`${candidate.ebayListingId}: submitted PictureURLs are not all on the configured proxy host.`)
  }
  const validatedByIndex = new Map(validated.map((entry) => [entry.index, entry]))

  return {
    candidate,
    item,
    asin: stored.asin,
    origin,
    entries: entries.map((entry) => validatedByIndex.get(entry.index) || entry),
    submitted: validated,
    pictureUrls: validated.map((entry) => entry.proxyUrl),
  }
}

async function verifyPictureRepair(account, plan) {
  let lastFailure = 'verification did not run'
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 1500))
    const live = await getItemDetails(account, plan.candidate.ebayListingId)
    if (live.title !== plan.candidate.newTitle || hasEncodedTitleArtifact(live.title)) {
      lastFailure = `title mismatch: ${live.title}`
      continue
    }
    if (live.hasVariations) {
      lastFailure = 'listing unexpectedly has variations'
      continue
    }
    if (live.pictures.length !== plan.submitted.length) {
      lastFailure = `picture count mismatch (${live.pictures.length}/${plan.submitted.length})`
      continue
    }

    // Self-hosted PictureURLs come back verbatim from GetItem with no eBay /s/<b64>/
    // dimension segment, so URL-declared dimensions cannot be used here (that false-
    // failed the first verified-good pilot). Measure the actual images instead.
    const postProbes = await mapLimit(live.pictures, 3, fetchImageProbe)
    const undersized = postProbes.filter((probe) => probe.longest < MIN_EBAY_PICTURE_SIDE)
    if (undersized.length > 0) {
      lastFailure = `live picture below ${MIN_EBAY_PICTURE_SIDE}px: ${undersized.map((probe) => `${probe.width}x${probe.height}`).join(', ')}`
      continue
    }
    const distances = postProbes.map((probe, index) => imageDistance(plan.submitted[index].proxyProbe, probe))
    if (distances.some((distance) => !isPerceptualMatch(distance, true))) {
      lastFailure = `picture order/content mismatch: ${distances.map((distance) => `${distance.hamming}/${distance.mae.toFixed(1)}`).join(', ')}`
      continue
    }
    return { live, distances }
  }
  throw new Error(`${plan.candidate.ebayListingId}: post-GetItem verification failed: ${lastFailure}`)
}

function getActiveXml(account, page) {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${ENTRIES_PER_PAGE}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
  <OutputSelector>ActiveList.ItemArray.Item.ItemID</OutputSelector>
  <OutputSelector>ActiveList.ItemArray.Item.Title</OutputSelector>
  <OutputSelector>ActiveList.PaginationResult.TotalNumberOfPages</OutputSelector>
  <OutputSelector>ActiveList.PaginationResult.TotalNumberOfEntries</OutputSelector>
</GetMyeBaySellingRequest>`
}

async function fetchActivePage(account, page) {
  const result = await tradingCall(account, 'GetMyeBaySelling', getActiveXml(account, page))
  if (!result.ok) {
    throw new Error(`${account.display}: GetMyeBaySelling failed on page ${page}: ${result.detail.message}`)
  }

  const listings = [...result.text.matchAll(/<Item>([\s\S]*?)<\/Item>/gi)]
    .map((match) => String(match[1] || ''))
    .map((block) => ({
      accountId: account.id,
      userId: account.userId,
      accountLabel: account.label,
      ebayListingId: tag(block, 'ItemID'),
      title: tag(block, 'Title'),
    }))
    .filter((listing) => Boolean(listing.ebayListingId && listing.title))

  const totalPagesText = tag(result.text, 'TotalNumberOfPages')
  const totalEntriesText = tag(result.text, 'TotalNumberOfEntries')
  if (!/^\d+$/.test(totalPagesText) || !/^\d+$/.test(totalEntriesText)) {
    throw new Error(`${account.display}: eBay omitted pagination totals; completeness cannot be proven, so nothing was changed.`)
  }

  return {
    listings,
    totalPages: Math.max(1, Number.parseInt(totalPagesText, 10)),
    totalEntries: Number.parseInt(totalEntriesText, 10),
  }
}

async function scanAccount(account) {
  const first = await fetchActivePage(account, 1)
  if (first.totalPages > MAX_PAGES_PER_ACCOUNT) {
    throw new Error(`${account.display}: ${first.totalPages} pages exceed the safe scan limit; nothing was changed.`)
  }

  const listings = [...first.listings]
  const pages = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_unused, index) => index + 2)
  for (let offset = 0; offset < pages.length; offset += SCAN_CONCURRENCY) {
    const batch = pages.slice(offset, offset + SCAN_CONCURRENCY)
    const results = await Promise.all(batch.map((page) => fetchActivePage(account, page)))
    for (const result of results) listings.push(...result.listings)
  }

  const unique = new Map(listings.map((listing) => [listing.ebayListingId, listing]))
  if (unique.size !== first.totalEntries) {
    throw new Error(
      `${account.display}: eBay reported ${first.totalEntries} active listings but the complete scan returned ${unique.size}; nothing was changed.`,
    )
  }
  return [...unique.values()]
}

async function scanAllAccounts(accounts, phase) {
  const listings = []
  console.log(`\n${phase}: scanning ${accounts.length} active eBay account${accounts.length === 1 ? '' : 's'}...`)
  for (const account of accounts) {
    const rows = await scanAccount(account)
    listings.push(...rows)
    console.log(`  ${account.display}: ${rows.length.toLocaleString()} active listings`)
  }
  return listings
}

function inspectTitles(listings) {
  const candidates = []
  const unsafe = []

  for (const listing of listings) {
    if (!hasEncodedTitleArtifact(listing.title)) continue
    const newTitle = repairEncodedEbayTitle(listing.title)
    const reason = !newTitle
      ? 'empty repaired title'
      : newTitle.length > 80
        ? `repaired title is ${newTitle.length} characters`
        : newTitle === listing.title
          ? 'decoder made no change'
          : hasEncodedTitleArtifact(newTitle)
            ? 'encoded artifact remains after decoding'
            : null

    if (reason) unsafe.push({ ...listing, newTitle, reason })
    else candidates.push({ ...listing, newTitle })
  }
  return { candidates, unsafe }
}

function printInspection(listings, inspection) {
  console.log(`  Scanned: ${listings.length.toLocaleString()}`)
  console.log(`  Safe mechanical repairs: ${inspection.candidates.length.toLocaleString()}`)
  console.log(`  Unsafe/unresolved artifacts: ${inspection.unsafe.length.toLocaleString()}`)

  for (const candidate of inspection.candidates.slice(0, 12)) {
    console.log(`\n  [${candidate.userId}/${candidate.accountLabel}] ${candidate.ebayListingId}`)
    console.log(`    BEFORE: ${candidate.title}`)
    console.log(`    AFTER:  ${candidate.newTitle}`)
  }
  if (inspection.candidates.length > 12) {
    console.log(`\n  ...${(inspection.candidates.length - 12).toLocaleString()} more repairable titles`)
  }
  for (const row of inspection.unsafe.slice(0, 5)) {
    console.log(`\n  UNSAFE ${row.ebayListingId}: ${row.reason}`)
  }
}

function printPictureRepairPlan(plan) {
  console.log(`\nPicture-remediation pilot: ${plan.candidate.ebayListingId}`)
  console.log(`  Account: user ${plan.candidate.userId} / ${plan.candidate.accountLabel}`)
  console.log(`  ASIN: ${plan.asin || 'untracked (drop-only fallback required)'}`)
  console.log(`  BEFORE: ${plan.candidate.title}`)
  console.log(`  AFTER:  ${plan.candidate.newTitle}`)
  console.log(`  Proxy origin: ${plan.origin}`)
  console.log(`  Current pictures: ${plan.item.pictures.length}; submitted pictures: ${plan.submitted.length}`)
  for (const entry of plan.entries) {
    const dimensions = `${entry.dimensions.width}x${entry.dimensions.height}`
    if (!entry.sourceUrl) {
      console.log(`    ${entry.index + 1}. DROP ${dimensions} ${entry.currentUrl}`)
      continue
    }
    const match = entry.matchDistance
      ? `; match ${entry.matchDistance.hamming}/${entry.matchDistance.mae.toFixed(2)}`
      : ''
    console.log(`    ${entry.index + 1}. ${entry.action} ${dimensions}${match}`)
    console.log(`       source: ${entry.sourceUrl}`)
    console.log(`       submit: ${entry.proxyUrl}`)
  }
  console.log('  Safety checks passed: one item, no variations, no coin category, no repaired-title collision, same-host proxy, >=500px proxy output.')
}

function reviseXml(account, candidate, picturePlan = null) {
  const pictureDetails = picturePlan
    ? `<PictureDetails>${picturePlan.pictureUrls.map((url) => `<PictureURL>${escapeXml(url)}</PictureURL>`).join('')}</PictureDetails>`
    : ''
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${escapeXml(account.accessToken)}</eBayAuthToken></RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <ItemID>${escapeXml(candidate.ebayListingId)}</ItemID>
    <Title>${escapeXml(candidate.newTitle)}</Title>
    ${pictureDetails}
  </Item>
</ReviseFixedPriceItemRequest>`
}

async function reviseCandidate(account, candidate, picturePlan = null) {
  const result = await tradingCall(account, 'ReviseFixedPriceItem', reviseXml(account, candidate, picturePlan))
  const transient = !result.ok && (
    result.status >= 500 ||
    /limit|quota|temporar|try again|system error|service unavailable/i.test(`${result.detail.code} ${result.detail.message}`)
  )
  return { ...result, transient }
}

async function updateStoredTitle(candidate) {
  return sql(`
    UPDATE listed_asins
    SET title = $3
    WHERE user_id = $1
      AND ebay_listing_id = $2
      AND ended_at IS NULL
    RETURNING id
  `, [Number(candidate.userId), candidate.ebayListingId, candidate.newTitle])
}

async function loadAccounts() {
  const params = []
  let userFilter = ''
  if (USER_ID !== null) {
    params.push(USER_ID)
    userFilter = 'AND user_id = $1'
  }
  const rows = await sql(`
    SELECT id, user_id, label, oauth_token, refresh_token, token_expires_at, sandbox_mode
    FROM ebay_accounts
    WHERE active = TRUE
      ${userFilter}
    ORDER BY user_id ASC, id ASC
  `, params)

  if (rows.length === 0) {
    throw new Error(USER_ID === null
      ? 'No active ebay_accounts rows were found.'
      : `No active eBay account was found for user ${USER_ID}.`)
  }

  return rows.map((row) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    label: String(row.label || `account ${row.id}`),
    display: `user ${row.user_id} / ${row.label || `account ${row.id}`}`,
    accessToken: String(row.oauth_token || ''),
    refreshToken: String(row.refresh_token || ''),
    tokenExpiresAt: row.token_expires_at ? String(row.token_expires_at) : '',
    sandboxMode: Boolean(row.sandbox_mode),
  }))
}

async function main() {
  console.log(`Encoded eBay title maintenance: ${APPLY ? 'APPLY' : 'PREVIEW (read-only)'}`)
  if (USER_ID !== null) console.log(`User filter: ${USER_ID}`)
  if (ALL_USERS) console.log('Scope acknowledgement: all active users')
  if (REPAIR_PICTURES) console.log(`Picture-remediation scope: item ${ITEM_ID} only`)

  const accounts = await loadAccounts()
  // Refresh in memory only when necessary. Preview mode never writes refreshed tokens or
  // anything else to the DB.
  for (const account of accounts) await refreshAccessToken(account)

  // Finish the entire preflight scan before the first possible revision. Any incomplete
  // account/page aborts the run with zero listing mutations.
  const initialListings = await scanAllAccounts(accounts, 'Preflight')
  const initial = inspectTitles(initialListings)

  if (REPAIR_PICTURES) {
    // Item-scoped when --item is given (the original pilot mode); otherwise every
    // remaining malformed-title candidate in this user's account. Each item still
    // passes the full per-item plan gates (no variations, no coin category, no
    // title collision, exact-ASIN perceptual matches, same-host proxy, >=500px).
    const targets = ITEM_ID
      ? initial.candidates.filter((row) => row.ebayListingId === ITEM_ID)
      : initial.candidates
    if (ITEM_ID) {
      const unsafeTarget = initial.unsafe.find((row) => row.ebayListingId === ITEM_ID)
      if (unsafeTarget) throw new Error(`${ITEM_ID}: encoded title is not mechanically safe: ${unsafeTarget.reason}`)
      if (targets.length === 0) {
        throw new Error(`${ITEM_ID}: no live malformed-title candidate was found in user ${USER_ID}'s complete account scan.`)
      }
    }
    console.log(`\nPicture-remediation targets: ${targets.length}`)

    let repaired = 0
    const skipped = []
    for (const rawCandidate of targets) {
      const account = accounts.find((row) => row.id === rawCandidate.accountId)
      if (!account) {
        skipped.push({ id: rawCandidate.ebayListingId, reason: `owning eBay account ${rawCandidate.accountId} is unavailable` })
        continue
      }
      const candidate = { ...rawCandidate, account }
      const accountListings = initialListings.filter((row) => row.accountId === candidate.accountId)
      let plan
      try {
        plan = await buildPictureRepairPlan(candidate, accountListings)
      } catch (error) {
        skipped.push({ id: candidate.ebayListingId, reason: String(error?.message || error) })
        continue
      }
      printPictureRepairPlan(plan)

      if (!APPLY) continue

      try {
        console.log(`\nApplying title+picture repair to ${candidate.ebayListingId}...`)
        const result = await reviseCandidate(account, candidate, plan)
        if (!result.ok) {
          throw new Error(`eBay rejected the revision: ${result.detail.code || 'EBAY'} ${result.detail.message}`)
        }
        // Do not synchronize the DB merely because eBay acknowledged the request. Re-read
        // the item and prove title, count, order, and visual content first.
        const verification = await verifyPictureRepair(account, plan)
        const updated = await updateStoredTitle(candidate)
        repaired += 1
        console.log(`VERIFIED COMPLETE: ${candidate.ebayListingId}`)
        console.log(`  Live title: ${verification.live.title}`)
        console.log(`  Live pictures: ${verification.live.pictures.length}; all measured >=${MIN_EBAY_PICTURE_SIDE}px; content distances ${verification.distances.map((distance) => `${distance.hamming}/${distance.mae.toFixed(1)}`).join(', ')}`)
        console.log(`  Database title rows synchronized: ${updated.length}`)
      } catch (error) {
        skipped.push({ id: candidate.ebayListingId, reason: String(error?.message || error) })
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }

    console.log(`\nPICTURE-REMEDIATION ${APPLY ? 'APPLY' : 'PREVIEW'} COMPLETE: ${APPLY ? `${repaired} repaired and verified, ` : ''}${skipped.length} skipped of ${targets.length} target(s).`)
    for (const entry of skipped) console.log(`  SKIPPED ${entry.id}: ${entry.reason}`)
    if (!APPLY) {
      console.log('\nNo eBay listing or database row was changed. Re-run with --apply to repair the plannable items above.')
    }
    return
  }

  printInspection(initialListings, initial)

  if (!APPLY) {
    console.log('\nPREVIEW COMPLETE: no eBay listing or database title was changed.')
    if (initial.candidates.length > 0) {
      const userArg = USER_ID === null ? ' --all-users' : ` --user=${USER_ID}`
      console.log(`To apply exactly these mechanical repairs, rerun with:${userArg} --apply`)
    }
    return
  }

  if (initial.unsafe.length > 0) {
    throw new Error(`Refusing to apply: ${initial.unsafe.length} encoded title(s) could not be repaired mechanically.`)
  }
  if (initial.candidates.length === 0) {
    console.log('\nAPPLY COMPLETE: all live titles were already clear; nothing changed.')
    return
  }

  console.log(`\nApplying ${initial.candidates.length.toLocaleString()} title-only revision${initial.candidates.length === 1 ? '' : 's'}...`)
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  let revised = 0
  let failed = 0
  let dbRowsUpdated = 0
  let dbSyncFailures = 0
  let stoppedForTransient = false

  for (const candidate of initial.candidates) {
    const account = accountById.get(candidate.accountId)
    if (!account) {
      failed += 1
      console.error(`  FAIL ${candidate.ebayListingId}: account ${candidate.accountId} is unavailable`)
      continue
    }

    let result
    try {
      result = await reviseCandidate(account, candidate)
    } catch (error) {
      failed += 1
      stoppedForTransient = true
      console.error(`  STOP ${candidate.ebayListingId}: ${String(error?.message || error)}`)
      break
    }

    if (!result.ok) {
      failed += 1
      console.error(`  FAIL ${candidate.ebayListingId}: ${result.detail.code || 'EBAY'} ${result.detail.message}`)
      if (result.transient) {
        stoppedForTransient = true
        console.error('  Stopping revisions on a transient/quota response; final verification will report what remains.')
        break
      }
      continue
    }

    revised += 1
    try {
      const updated = await updateStoredTitle(candidate)
      dbRowsUpdated += updated.length
      console.log(`  OK   ${candidate.ebayListingId}${updated.length === 0 ? ' (live-only; no active DB row)' : ''}`)
    } catch (error) {
      dbSyncFailures += 1
      console.error(`  DB   ${candidate.ebayListingId}: eBay is fixed, but listed_asins sync failed: ${String(error?.message || error)}`)
    }

    await new Promise((resolve) => setTimeout(resolve, REVISION_DELAY_MS))
  }

  console.log(`\nRevision results: ${revised} acknowledged, ${failed} failed, ${dbRowsUpdated} DB row(s) synchronized.`)
  if (stoppedForTransient) console.log('The run stopped early on a transient response and is expected to exit nonzero.')

  // Authoritative verification: discard the preflight data and pull every live title again.
  const verifiedListings = await scanAllAccounts(accounts, 'Post-apply verification')
  const verified = inspectTitles(verifiedListings)
  console.log(`\nVerification remaining: ${verified.candidates.length} repairable, ${verified.unsafe.length} unsafe/unresolved.`)
  for (const row of [...verified.candidates, ...verified.unsafe].slice(0, 10)) {
    console.log(`  REMAINS [${row.userId}/${row.accountLabel}] ${row.ebayListingId}: ${row.title}`)
  }

  if (verified.candidates.length > 0 || verified.unsafe.length > 0 || dbSyncFailures > 0) {
    process.exitCode = 1
    console.error('\nINCOMPLETE: malformed live titles or database synchronization errors remain.')
    return
  }

  console.log(`\nVERIFIED COMPLETE: all ${verifiedListings.length.toLocaleString()} live titles are clear of encoded artifacts.`)
}

main().catch((error) => {
  console.error(`\nFAILED: ${String(error?.message || error)}`)
  process.exitCode = 1
})
